// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title FundVault
 * @notice Core vault for Moltbook Ventures Fund 0 with two-tier share structure
 * @dev Class A (voting) and Class B (non-voting) shares
 */
contract FundVault is Ownable, ReentrancyGuard {
    IERC20 public immutable usdc;
    ShareToken public immutable classA; // Voting shares
    ShareToken public immutable classB; // Non-voting shares
    
    uint256 public constant MANAGEMENT_FEE_BPS = 200; // 2% annual
    uint256 public constant CARRY_BPS = 2000; // 20%
    uint256 public constant SECONDS_PER_YEAR = 365 days;
    
    uint256 public lastFeeCollection;
    uint256 public totalDeployed;
    uint256 public totalReturns;
    uint256 public totalDividends; // Total dividends ever distributed
    
    // Per-share dividend tracking (cumulative)
    uint256 public dividendsPerShare; // Scaled by 1e18
    // LP → ShareToken address → last claimed dividends per share
    mapping(address => mapping(address => uint256)) public dividendsPerShareClaimed;
    
    struct Investment {
        address target;
        uint256 amount;
        uint256 equityPercent;
        uint256 timestamp;
        bool exited;
        uint256 returnAmount;
    }
    
    Investment[] public investments;
    
    event Deposited(address indexed lp, bool isClassA, uint256 usdcAmount, uint256 sharesIssued);
    event InvestmentExecuted(uint256 indexed investmentId, address target, uint256 amount, uint256 equityPercent);
    event ReturnRecorded(uint256 indexed investmentId, uint256 returnAmount, uint256 profit);
    event ManagementFeeCollected(uint256 amount);
    event DividendDistributed(uint256 totalAmount, uint256 perShare);
    
    constructor(address _usdc) Ownable(msg.sender) {
        usdc = IERC20(_usdc);
        classA = new ShareToken("Moltbook Ventures LP Class A", "MVLP-A");
        classB = new ShareToken("Moltbook Ventures LP Class B", "MVLP-B");
        lastFeeCollection = block.timestamp;
    }
    
    /**
     * @notice Deposit USDC to receive Class B (non-voting) LP tokens
     * @param amount USDC amount to deposit
     */
    function deposit(uint256 amount) external nonReentrant {
        require(amount > 0, "Amount must be > 0");
        
        // Public deposits always get Class B (non-voting)
        uint256 totalAUM = usdc.balanceOf(address(this)) + totalDeployed;
        uint256 totalShares = classA.totalSupply() + classB.totalSupply();
        
        uint256 sharesToMint;
        if (totalShares == 0) {
            sharesToMint = amount; // 1:1 for first deposit
        } else {
            sharesToMint = (amount * totalShares) / totalAUM;
        }
        
        require(usdc.transferFrom(msg.sender, address(this), amount), "Transfer failed");
        classB.mint(msg.sender, sharesToMint);
        
        // Set dividend tracking
        dividendsPerShareClaimed[msg.sender][address(classB)] = dividendsPerShare;
        
        emit Deposited(msg.sender, false, amount, sharesToMint);
    }
    
    /**
     * @notice Mint Class A (voting) shares to GPs only
     * @param gp GP address to receive voting shares
     * @param amount USDC amount the GP is contributing
     */
    function mintClassA(address gp, uint256 amount) external onlyOwner nonReentrant {
        require(amount > 0, "Amount must be > 0");
        
        uint256 totalAUM = usdc.balanceOf(address(this)) + totalDeployed;
        uint256 totalShares = classA.totalSupply() + classB.totalSupply();
        
        uint256 sharesToMint;
        if (totalShares == 0) {
            sharesToMint = amount;
        } else {
            sharesToMint = (amount * totalShares) / totalAUM;
        }
        
        require(usdc.transferFrom(gp, address(this), amount), "Transfer failed");
        classA.mint(gp, sharesToMint);
        
        // Set dividend tracking
        dividendsPerShareClaimed[gp][address(classA)] = dividendsPerShare;
        
        emit Deposited(gp, true, amount, sharesToMint);
    }
    
    /**
     * @notice Execute an approved investment (owner = Gnosis Safe)
     * @param target Company wallet address
     * @param amount USDC to invest
     * @param equityPercent Equity stake (in basis points, e.g., 1500 = 15%)
     */
    function executeInvestment(
        address target,
        uint256 amount,
        uint256 equityPercent
    ) external onlyOwner nonReentrant returns (uint256) {
        require(usdc.balanceOf(address(this)) >= amount, "Insufficient balance");
        require(equityPercent > 0 && equityPercent <= 10000, "Invalid equity %");
        
        investments.push(Investment({
            target: target,
            amount: amount,
            equityPercent: equityPercent,
            timestamp: block.timestamp,
            exited: false,
            returnAmount: 0
        }));
        
        totalDeployed += amount;
        require(usdc.transfer(target, amount), "Transfer failed");
        
        uint256 investmentId = investments.length - 1;
        emit InvestmentExecuted(investmentId, target, amount, equityPercent);
        
        return investmentId;
    }
    
    /**
     * @notice Record returns from an exit
     * @param investmentId Investment identifier
     * @param returnAmount USDC returned from exit
     */
    function recordReturn(
        uint256 investmentId,
        uint256 returnAmount
    ) external onlyOwner {
        require(investmentId < investments.length, "Invalid investment ID");
        Investment storage inv = investments[investmentId];
        require(!inv.exited, "Already exited");
        
        inv.exited = true;
        inv.returnAmount = returnAmount;
        totalDeployed -= inv.amount; // Decrease deployed capital on exit
        totalReturns += returnAmount;
        
        // Calculate profit and carry
        uint256 profit = returnAmount > inv.amount ? returnAmount - inv.amount : 0;
        uint256 carry = (profit * CARRY_BPS) / 10000;
        
        // Carry goes to owner (GP)
        if (carry > 0) {
            require(usdc.transfer(owner(), carry), "Carry transfer failed");
        }
        
        emit ReturnRecorded(investmentId, returnAmount, profit);
    }
    
    /**
     * @notice Redeem LP shares for proportional USDC
     * @param amount Shares to redeem
     * @param isClassA True for Class A, false for Class B
     */
    function redeem(uint256 amount, bool isClassA) external nonReentrant {
        ShareToken shareToken = isClassA ? classA : classB;
        require(shareToken.balanceOf(msg.sender) >= amount, "Insufficient shares");
        
        uint256 totalShares = classA.totalSupply() + classB.totalSupply();
        uint256 availableUSDC = usdc.balanceOf(address(this));
        uint256 usdcAmount = (amount * availableUSDC) / totalShares;
        
        shareToken.burn(msg.sender, amount);
        require(usdc.transfer(msg.sender, usdcAmount), "Transfer failed");
    }
    
    /**
     * @notice Distribute dividends to all LPs (both Class A and B)
     * @param amount USDC amount to distribute
     */
    function distributeDividends(uint256 amount) external onlyOwner {
        require(amount > 0, "Amount must be > 0");
        require(usdc.balanceOf(address(this)) >= amount, "Insufficient balance");
        
        uint256 totalShares = classA.totalSupply() + classB.totalSupply();
        require(totalShares > 0, "No shares exist");
        
        // Update cumulative dividends per share
        uint256 dividendPerShareIncrease = (amount * 1e18) / totalShares;
        dividendsPerShare += dividendPerShareIncrease;
        totalDividends += amount;
        
        emit DividendDistributed(amount, dividendPerShareIncrease);
    }
    
    /**
     * @notice Claim pending dividends
     * @param isClassA True to claim from Class A shares, false for Class B
     */
    function claimDividends(bool isClassA) external nonReentrant {
        ShareToken shareToken = isClassA ? classA : classB;
        uint256 shares = shareToken.balanceOf(msg.sender);
        require(shares > 0, "No shares held");
        
        // Calculate pending dividends for this share class
        uint256 lastClaimed = dividendsPerShareClaimed[msg.sender][address(shareToken)];
        uint256 newDividends = (shares * (dividendsPerShare - lastClaimed)) / 1e18;
        
        if (newDividends > 0) {
            dividendsPerShareClaimed[msg.sender][address(shareToken)] = dividendsPerShare;
            require(usdc.transfer(msg.sender, newDividends), "Transfer failed");
        }
    }
    
    /**
     * @notice View pending dividends for an LP
     * @param lp LP address
     * @param isClassA True for Class A, false for Class B
     */
    function viewPendingDividends(address lp, bool isClassA) external view returns (uint256) {
        ShareToken shareToken = isClassA ? classA : classB;
        uint256 shares = shareToken.balanceOf(lp);
        if (shares == 0) return 0;
        
        uint256 lastClaimed = dividendsPerShareClaimed[lp][address(shareToken)];
        return (shares * (dividendsPerShare - lastClaimed)) / 1e18;
    }
    
    /**
     * @notice Collect management fee (2% annual)
     */
    function collectManagementFee() external onlyOwner {
        uint256 timeElapsed = block.timestamp - lastFeeCollection;
        uint256 aum = usdc.balanceOf(address(this)) + totalDeployed;
        
        uint256 feeAmount = (aum * MANAGEMENT_FEE_BPS * timeElapsed) / (10000 * SECONDS_PER_YEAR);
        
        if (feeAmount > 0 && usdc.balanceOf(address(this)) >= feeAmount) {
            require(usdc.transfer(owner(), feeAmount), "Fee transfer failed");
            lastFeeCollection = block.timestamp;
            emit ManagementFeeCollected(feeAmount);
        }
    }
    
    /**
     * @notice Get current NAV per share
     * @return NAV in USDC (18 decimals)
     */
    function navPerShare() external view returns (uint256) {
        uint256 totalShares = classA.totalSupply() + classB.totalSupply();
        if (totalShares == 0) return 1e18;
        
        uint256 nav = usdc.balanceOf(address(this)) + totalDeployed; // Total AUM
        return (nav * 1e18) / totalShares;
    }
    
    /**
     * @notice Get fund statistics
     */
    function fundStats() external view returns (
        uint256 totalAUM,
        uint256 deployed,
        uint256 available,
        uint256 totalReturnAmount,
        uint256 totalSharesA,
        uint256 totalSharesB
    ) {
        totalAUM = usdc.balanceOf(address(this)) + totalDeployed;
        deployed = totalDeployed;
        available = usdc.balanceOf(address(this));
        totalReturnAmount = totalReturns;
        totalSharesA = classA.totalSupply();
        totalSharesB = classB.totalSupply();
    }
    
    /**
     * @notice Get investment details
     */
    function getInvestment(uint256 id) external view returns (Investment memory) {
        require(id < investments.length, "Invalid ID");
        return investments[id];
    }
    
    function investmentCount() external view returns (uint256) {
        return investments.length;
    }
}

/**
 * @title ShareToken
 * @notice ERC20 token for LP shares (Class A or B)
 */
contract ShareToken is ERC20 {
    address public immutable vault;
    
    constructor(string memory name, string memory symbol) ERC20(name, symbol) {
        vault = msg.sender;
    }
    
    modifier onlyVault() {
        require(msg.sender == vault, "Only vault can mint/burn");
        _;
    }
    
    function mint(address to, uint256 amount) external onlyVault {
        _mint(to, amount);
    }
    
    function burn(address from, uint256 amount) external onlyVault {
        _burn(from, amount);
    }
}
