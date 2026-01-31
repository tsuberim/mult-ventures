import { expect } from "chai";
import { ethers } from "hardhat";

describe("Governance", function () {
  let fundVault, governance, classA, usdc;
  let owner, voter1, voter2, voter3, company, equityContract;
  
  beforeEach(async function () {
    [owner, voter1, voter2, voter3, company, equityContract] = await ethers.getSigners();
    
    // Deploy mock USDC
    const MockERC20 = await ethers.getContractFactory("MockERC20");
    usdc = await MockERC20.deploy("USD Coin", "USDC", 6);
    
    // Deploy FundVault
    const FundVault = await ethers.getContractFactory("FundVault");
    fundVault = await FundVault.deploy(await usdc.getAddress());
    
    // Deploy Governance
    const Governance = await ethers.getContractFactory("Governance");
    governance = await Governance.deploy(await fundVault.getAddress());
    
    classA = await ethers.getContractAt("ShareToken", await fundVault.classA());
    
    // Setup LPs with Class A shares
    await usdc.mint(voter1.address, ethers.parseUnits("10000", 6));
    await usdc.mint(voter2.address, ethers.parseUnits("10000", 6));
    await usdc.mint(voter3.address, ethers.parseUnits("10000", 6));
    
    await usdc.connect(voter1).approve(await fundVault.getAddress(), ethers.MaxUint256);
    await usdc.connect(voter2).approve(await fundVault.getAddress(), ethers.MaxUint256);
    await usdc.connect(voter3).approve(await fundVault.getAddress(), ethers.MaxUint256);
    
    // Deposit to get Class A shares
    await fundVault.connect(voter1).deposit(ethers.parseUnits("1000", 6), true);
    await fundVault.connect(voter2).deposit(ethers.parseUnits("1000", 6), true);
    await fundVault.connect(voter3).deposit(ethers.parseUnits("1000", 6), true);
  });
  
  describe("Proposals", function () {
    it("Should create proposal with required parameters", async function () {
      await governance.propose(
        company.address,
        ethers.parseUnits("500", 6),
        1500, // 15% equity
        "Test investment",
        equityContract.address
      );
      
      const proposal = await governance.getProposal(0);
      expect(proposal.target).to.equal(company.address);
      expect(proposal.amount).to.equal(ethers.parseUnits("500", 6));
      expect(proposal.equityPercent).to.equal(1500);
      expect(proposal.equityContract).to.equal(equityContract.address);
    });
    
    it("Should require equity contract address", async function () {
      await expect(
        governance.propose(
          company.address,
          ethers.parseUnits("500", 6),
          1500,
          "Test investment",
          ethers.ZeroAddress // Invalid!
        )
      ).to.be.revertedWith("Must provide equity contract");
    });
    
    it("Should only allow owner (GP) to propose", async function () {
      await expect(
        governance.connect(voter1).propose(
          company.address,
          ethers.parseUnits("500", 6),
          1500,
          "Test investment",
          equityContract.address
        )
      ).to.be.revertedWith("Only GP can propose");
    });
    
    it("Should set 24h voting period", async function () {
      await governance.propose(
        company.address,
        ethers.parseUnits("500", 6),
        1500,
        "Test investment",
        equityContract.address
      );
      
      const proposal = await governance.getProposal(0);
      const block = await ethers.provider.getBlock("latest");
      
      expect(proposal.startTime).to.equal(block.timestamp);
      expect(proposal.endTime).to.equal(block.timestamp + 24 * 60 * 60);
    });
  });
  
  describe("Voting", function () {
    beforeEach(async function () {
      await governance.propose(
        company.address,
        ethers.parseUnits("1000", 6), // 33% of 3000 AUM = requires vote
        1500,
        "Test investment",
        equityContract.address
      );
    });
    
    it("Should allow Class A holders to vote", async function () {
      await governance.connect(voter1).vote(0, true);
      
      const proposal = await governance.getProposal(0);
      expect(proposal.votesFor).to.equal(ethers.parseUnits("1000", 6));
    });
    
    it("Should track votes by weight (share balance)", async function () {
      await governance.connect(voter1).vote(0, true);
      await governance.connect(voter2).vote(0, false);
      
      const proposal = await governance.getProposal(0);
      expect(proposal.votesFor).to.equal(ethers.parseUnits("1000", 6));
      expect(proposal.votesAgainst).to.equal(ethers.parseUnits("1000", 6));
    });
    
    it("Should prevent double voting", async function () {
      await governance.connect(voter1).vote(0, true);
      
      await expect(
        governance.connect(voter1).vote(0, true)
      ).to.be.revertedWith("Already voted");
    });
    
    it("Should check hasVoted correctly", async function () {
      await governance.connect(voter1).vote(0, true);
      
      expect(await governance.hasVoted(0, voter1.address)).to.be.true;
      expect(await governance.hasVoted(0, voter2.address)).to.be.false;
    });
    
    it("Should reject votes after voting period", async function () {
      await ethers.provider.send("evm_increaseTime", [25 * 60 * 60]); // 25 hours
      await ethers.provider.send("evm_mine");
      
      await expect(
        governance.connect(voter1).vote(0, true)
      ).to.be.revertedWith("Voting ended");
    });
    
    it("Should require voting power (shares)", async function () {
      const noShares = (await ethers.getSigners())[10];
      
      await expect(
        governance.connect(noShares).vote(0, true)
      ).to.be.revertedWith("No voting power");
    });
  });
  
  describe("Dynamic Threshold (30% of AUM)", function () {
    it("Should allow small investments without vote", async function () {
      // Fund has 3000 USDC, 30% = 900
      // Investment of 500 should not require vote
      await governance.propose(
        company.address,
        ethers.parseUnits("500", 6),
        1500,
        "Small investment",
        equityContract.address
      );
      
      // Fast forward past voting period
      await ethers.provider.send("evm_increaseTime", [25 * 60 * 60]);
      await ethers.provider.send("evm_mine");
      
      // Should execute without votes
      await expect(
        governance.execute(0)
      ).to.not.be.reverted;
    });
    
    it("Should require vote for large investments (≥30% AUM)", async function () {
      // Fund has 3000 USDC, 30% = 900
      // Investment of 1000 requires vote
      await governance.propose(
        company.address,
        ethers.parseUnits("1000", 6),
        1500,
        "Large investment",
        equityContract.address
      );
      
      await ethers.provider.send("evm_increaseTime", [25 * 60 * 60]);
      await ethers.provider.send("evm_mine");
      
      // Should fail without votes (quorum not met)
      await expect(
        governance.execute(0)
      ).to.be.revertedWith("Quorum not met");
    });
    
    it("Should scale threshold with fund size", async function () {
      // Add more capital
      await usdc.mint(voter1.address, ethers.parseUnits("10000", 6));
      await fundVault.connect(voter1).deposit(ethers.parseUnits("10000", 6), true);
      
      // Now fund has 13000, 30% = 3900
      // 1000 should no longer require vote
      await governance.propose(
        company.address,
        ethers.parseUnits("1000", 6),
        1500,
        "Now small investment",
        equityContract.address
      );
      
      await ethers.provider.send("evm_increaseTime", [25 * 60 * 60]);
      await ethers.provider.send("evm_mine");
      
      // Should execute without votes
      await expect(
        governance.execute(0)
      ).to.not.be.reverted;
    });
  });
  
  describe("Execution", function () {
    beforeEach(async function () {
      await governance.propose(
        company.address,
        ethers.parseUnits("1000", 6), // Requires vote
        1500,
        "Test investment",
        equityContract.address
      );
    });
    
    it("Should execute after passing vote", async function () {
      // 2 voters approve (2000/3000 = 66% quorum, 100% approval)
      await governance.connect(voter1).vote(0, true);
      await governance.connect(voter2).vote(0, true);
      
      await ethers.provider.send("evm_increaseTime", [25 * 60 * 60]);
      await ethers.provider.send("evm_mine");
      
      await governance.execute(0);
      
      // Check vault executed investment
      const inv = await fundVault.getInvestment(0);
      expect(inv.amount).to.equal(ethers.parseUnits("1000", 6));
    });
    
    it("Should require 30% quorum", async function () {
      // Only 1 voter (1000/3000 = 33% quorum, meets minimum)
      await governance.connect(voter1).vote(0, true);
      
      await ethers.provider.send("evm_increaseTime", [25 * 60 * 60]);
      await ethers.provider.send("evm_mine");
      
      // Should pass (33% > 30% quorum requirement)
      await expect(
        governance.execute(0)
      ).to.not.be.reverted;
    });
    
    it("Should fail if quorum not met", async function () {
      // No votes (0% quorum)
      await ethers.provider.send("evm_increaseTime", [25 * 60 * 60]);
      await ethers.provider.send("evm_mine");
      
      await expect(
        governance.execute(0)
      ).to.be.revertedWith("Quorum not met");
    });
    
    it("Should require 51% approval", async function () {
      // 2 for, 1 against (66% approval, passes)
      await governance.connect(voter1).vote(0, true);
      await governance.connect(voter2).vote(0, true);
      await governance.connect(voter3).vote(0, false);
      
      await ethers.provider.send("evm_increaseTime", [25 * 60 * 60]);
      await ethers.provider.send("evm_mine");
      
      await expect(
        governance.execute(0)
      ).to.not.be.reverted;
    });
    
    it("Should fail if approval < 51%", async function () {
      // 1 for, 2 against (33% approval, fails)
      await governance.connect(voter1).vote(0, true);
      await governance.connect(voter2).vote(0, false);
      await governance.connect(voter3).vote(0, false);
      
      await ethers.provider.send("evm_increaseTime", [25 * 60 * 60]);
      await ethers.provider.send("evm_mine");
      
      await expect(
        governance.execute(0)
      ).to.be.revertedWith("Proposal rejected");
    });
    
    it("Should prevent execution before voting ends", async function () {
      await governance.connect(voter1).vote(0, true);
      await governance.connect(voter2).vote(0, true);
      
      await expect(
        governance.execute(0)
      ).to.be.revertedWith("Voting still active");
    });
    
    it("Should only allow owner (GP) to execute", async function () {
      await governance.connect(voter1).vote(0, true);
      await governance.connect(voter2).vote(0, true);
      
      await ethers.provider.send("evm_increaseTime", [25 * 60 * 60]);
      await ethers.provider.send("evm_mine");
      
      await expect(
        governance.connect(voter1).execute(0)
      ).to.be.revertedWith("Only GP can execute");
    });
  });
  
  describe("Proposal Cancellation", function () {
    it("Should allow owner to cancel proposal", async function () {
      await governance.propose(
        company.address,
        ethers.parseUnits("500", 6),
        1500,
        "Test investment",
        equityContract.address
      );
      
      await governance.cancel(0);
      
      const proposal = await governance.getProposal(0);
      expect(proposal.cancelled).to.be.true;
    });
    
    it("Should prevent voting on cancelled proposals", async function () {
      await governance.propose(
        company.address,
        ethers.parseUnits("500", 6),
        1500,
        "Test investment",
        equityContract.address
      );
      
      await governance.cancel(0);
      
      await expect(
        governance.connect(voter1).vote(0, true)
      ).to.be.revertedWith("Proposal cancelled");
    });
  });
  
  describe("Proposal State", function () {
    it("Should return correct voting active state", async function () {
      await governance.propose(
        company.address,
        ethers.parseUnits("500", 6),
        1500,
        "Test investment",
        equityContract.address
      );
      
      let state = await governance.getProposalState(0);
      expect(state.votingActive).to.be.true;
      
      await ethers.provider.send("evm_increaseTime", [25 * 60 * 60]);
      await ethers.provider.send("evm_mine");
      
      state = await governance.getProposalState(0);
      expect(state.votingActive).to.be.false;
    });
    
    it("Should return correct executable state", async function () {
      await governance.propose(
        company.address,
        ethers.parseUnits("500", 6), // Small, no vote needed
        1500,
        "Test investment",
        equityContract.address
      );
      
      let state = await governance.getProposalState(0);
      expect(state.executable).to.be.false; // Still voting
      
      await ethers.provider.send("evm_increaseTime", [25 * 60 * 60]);
      await ethers.provider.send("evm_mine");
      
      state = await governance.getProposalState(0);
      expect(state.executable).to.be.true; // Voting ended, no vote required
    });
  });
});
