// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./FundVault.sol";

/**
 * @title Governance
 * @notice Voting system for Class A shareholders
 * @dev Allows Class A holders to vote on investments above threshold
 */
contract Governance {
    FundVault public immutable vault;
    ShareToken public immutable classA;
    
    uint256 public constant VOTING_PERIOD = 24 hours;
    uint256 public constant QUORUM_BPS = 3000; // 30% of Class A must vote
    uint256 public constant APPROVAL_BPS = 5100; // 51% approval required
    uint256 public constant LARGE_INVESTMENT_THRESHOLD_BPS = 3000; // 30% of total fund AUM
    
    struct Proposal {
        uint256 id;
        address target; // Company wallet receiving investment
        uint256 amount;
        uint256 equityPercent;
        string description;
        address equityContract; // Smart contract for equity/dividends (REQUIRED)
        uint256 startTime;
        uint256 endTime;
        uint256 votesFor;
        uint256 votesAgainst;
        bool executed;
        bool cancelled;
        mapping(address => bool) hasVoted;
    }
    
    uint256 public proposalCount;
    mapping(uint256 => Proposal) public proposals;
    
    event ProposalCreated(uint256 indexed proposalId, address target, uint256 amount, uint256 equityPercent);
    event VoteCast(uint256 indexed proposalId, address indexed voter, bool support, uint256 weight);
    event ProposalExecuted(uint256 indexed proposalId, uint256 investmentId);
    event ProposalCancelled(uint256 indexed proposalId);
    
    constructor(address _vault) {
        vault = FundVault(_vault);
        classA = vault.classA();
    }
    
    /**
     * @notice Create investment proposal (GP only)
     * @param target Company wallet address
     * @param amount USDC amount
     * @param equityPercent Equity stake in bps
     * @param description Investment thesis
     * @param equityContract Smart contract address for equity/dividends (REQUIRED)
     */
    function propose(
        address target,
        uint256 amount,
        uint256 equityPercent,
        string calldata description,
        address equityContract
    ) external returns (uint256) {
        require(msg.sender == vault.owner(), "Only GP can propose");
        require(amount > 0, "Amount must be > 0");
        require(equityPercent > 0 && equityPercent <= 10000, "Invalid equity %");
        require(equityContract != address(0), "Must provide equity contract");
        
        uint256 proposalId = proposalCount++;
        Proposal storage prop = proposals[proposalId];
        
        prop.id = proposalId;
        prop.target = target;
        prop.amount = amount;
        prop.equityPercent = equityPercent;
        prop.description = description;
        prop.equityContract = equityContract;
        prop.startTime = block.timestamp;
        prop.endTime = block.timestamp + VOTING_PERIOD;
        
        emit ProposalCreated(proposalId, target, amount, equityPercent);
        
        return proposalId;
    }
    
    /**
     * @notice Vote on a proposal (Class A holders only)
     * @param proposalId Proposal to vote on
     * @param support True to approve, false to reject
     */
    function vote(uint256 proposalId, bool support) external {
        Proposal storage prop = proposals[proposalId];
        require(block.timestamp >= prop.startTime, "Voting not started");
        require(block.timestamp <= prop.endTime, "Voting ended");
        require(!prop.executed, "Already executed");
        require(!prop.cancelled, "Proposal cancelled");
        require(!prop.hasVoted[msg.sender], "Already voted");
        
        uint256 weight = classA.balanceOf(msg.sender);
        require(weight > 0, "No voting power");
        
        prop.hasVoted[msg.sender] = true;
        
        if (support) {
            prop.votesFor += weight;
        } else {
            prop.votesAgainst += weight;
        }
        
        emit VoteCast(proposalId, msg.sender, support, weight);
    }
    
    /**
     * @notice Execute approved proposal (GP only)
     * @param proposalId Proposal to execute
     */
    function execute(uint256 proposalId) external returns (uint256) {
        require(msg.sender == vault.owner(), "Only GP can execute");
        
        Proposal storage prop = proposals[proposalId];
        require(block.timestamp > prop.endTime, "Voting still active");
        require(!prop.executed, "Already executed");
        require(!prop.cancelled, "Proposal cancelled");
        
        // Check if proposal needs voting (amount >= 30% of fund AUM)
        uint256 fundAUM = vault.usdc().balanceOf(address(vault)) + vault.totalDeployed();
        uint256 threshold = (fundAUM * LARGE_INVESTMENT_THRESHOLD_BPS) / 10000;
        
        if (prop.amount >= threshold) {
            uint256 totalVotes = prop.votesFor + prop.votesAgainst;
            uint256 totalClassA = classA.totalSupply();
            
            // Check quorum (30% of Class A must vote)
            require(
                totalVotes * 10000 >= totalClassA * QUORUM_BPS,
                "Quorum not met"
            );
            
            // Check approval (51% of votes must be for)
            require(
                prop.votesFor * 10000 >= totalVotes * APPROVAL_BPS,
                "Proposal rejected"
            );
        }
        
        prop.executed = true;
        
        uint256 investmentId = vault.executeInvestment(
            prop.target,
            prop.amount,
            prop.equityPercent
        );
        
        emit ProposalExecuted(proposalId, investmentId);
        
        return investmentId;
    }
    
    /**
     * @notice Cancel a proposal (GP only)
     * @param proposalId Proposal to cancel
     */
    function cancel(uint256 proposalId) external {
        require(msg.sender == vault.owner(), "Only GP can cancel");
        
        Proposal storage prop = proposals[proposalId];
        require(!prop.executed, "Already executed");
        require(!prop.cancelled, "Already cancelled");
        
        prop.cancelled = true;
        
        emit ProposalCancelled(proposalId);
    }
    
    /**
     * @notice Get proposal status
     */
    function getProposalState(uint256 proposalId) external view returns (
        bool votingActive,
        bool passedQuorum,
        bool approved,
        bool executable
    ) {
        Proposal storage prop = proposals[proposalId];
        
        votingActive = block.timestamp >= prop.startTime && 
                      block.timestamp <= prop.endTime &&
                      !prop.executed &&
                      !prop.cancelled;
        
        uint256 totalVotes = prop.votesFor + prop.votesAgainst;
        uint256 totalClassA = classA.totalSupply();
        
        passedQuorum = totalVotes * 10000 >= totalClassA * QUORUM_BPS;
        approved = totalVotes > 0 && prop.votesFor * 10000 >= totalVotes * APPROVAL_BPS;
        
        uint256 fundAUM = vault.usdc().balanceOf(address(vault)) + vault.totalDeployed();
        uint256 threshold = (fundAUM * LARGE_INVESTMENT_THRESHOLD_BPS) / 10000;
        
        executable = block.timestamp > prop.endTime &&
                    !prop.executed &&
                    !prop.cancelled &&
                    (prop.amount < threshold || (passedQuorum && approved));
    }
    
    /**
     * @notice Get proposal details
     */
    function getProposal(uint256 proposalId) external view returns (
        address target,
        uint256 amount,
        uint256 equityPercent,
        string memory description,
        address equityContract,
        uint256 startTime,
        uint256 endTime,
        uint256 votesFor,
        uint256 votesAgainst,
        bool executed,
        bool cancelled
    ) {
        Proposal storage prop = proposals[proposalId];
        return (
            prop.target,
            prop.amount,
            prop.equityPercent,
            prop.description,
            prop.equityContract,
            prop.startTime,
            prop.endTime,
            prop.votesFor,
            prop.votesAgainst,
            prop.executed,
            prop.cancelled
        );
    }
    
    /**
     * @notice Check if address has voted on proposal
     */
    function hasVoted(uint256 proposalId, address voter) external view returns (bool) {
        return proposals[proposalId].hasVoted[voter];
    }
}
