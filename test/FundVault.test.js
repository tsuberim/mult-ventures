import { expect } from "chai";
import { ethers } from "hardhat";

describe("FundVault", function () {
  let fundVault, classA, classB, usdc;
  let owner, lp1, lp2, company;
  
  beforeEach(async function () {
    [owner, lp1, lp2, company] = await ethers.getSigners();
    
    // Deploy mock USDC
    const MockERC20 = await ethers.getContractFactory("MockERC20");
    usdc = await MockERC20.deploy("USD Coin", "USDC", 6);
    
    // Deploy FundVault
    const FundVault = await ethers.getContractFactory("FundVault");
    fundVault = await FundVault.deploy(await usdc.getAddress());
    
    classA = await ethers.getContractAt("ShareToken", await fundVault.classA());
    classB = await ethers.getContractAt("ShareToken", await fundVault.classB());
    
    // Mint USDC to LPs
    await usdc.mint(lp1.address, ethers.parseUnits("10000", 6));
    await usdc.mint(lp2.address, ethers.parseUnits("10000", 6));
    
    // Approve vault
    await usdc.connect(lp1).approve(await fundVault.getAddress(), ethers.MaxUint256);
    await usdc.connect(lp2).approve(await fundVault.getAddress(), ethers.MaxUint256);
  });
  
  describe("Deposits", function () {
    it("Should mint Class A shares 1:1 for first deposit", async function () {
      const amount = ethers.parseUnits("1000", 6);
      await fundVault.connect(lp1).deposit(amount, true);
      
      expect(await classA.balanceOf(lp1.address)).to.equal(amount);
      expect(await usdc.balanceOf(await fundVault.getAddress())).to.equal(amount);
    });
    
    it("Should mint Class B shares 1:1 for first deposit", async function () {
      const amount = ethers.parseUnits("1000", 6);
      await fundVault.connect(lp1).deposit(amount, false);
      
      expect(await classB.balanceOf(lp1.address)).to.equal(amount);
    });
    
    it("Should mint shares proportionally for subsequent deposits", async function () {
      await fundVault.connect(lp1).deposit(ethers.parseUnits("1000", 6), true);
      await fundVault.connect(lp2).deposit(ethers.parseUnits("1000", 6), true);
      
      expect(await classA.balanceOf(lp1.address)).to.equal(ethers.parseUnits("1000", 6));
      expect(await classA.balanceOf(lp2.address)).to.equal(ethers.parseUnits("1000", 6));
    });
    
    it("Should use total AUM (not just vault balance) for share calculation", async function () {
      // LP1 deposits 1000
      await fundVault.connect(lp1).deposit(ethers.parseUnits("1000", 6), true);
      
      // Invest 900 (leaving 100 in vault)
      await fundVault.executeInvestment(
        company.address,
        ethers.parseUnits("900", 6),
        1500 // 15%
      );
      
      // LP2 deposits 1000
      // Should get 1000 shares (based on total AUM of 1000, not vault balance of 100)
      await fundVault.connect(lp2).deposit(ethers.parseUnits("1000", 6), true);
      
      expect(await classA.balanceOf(lp2.address)).to.equal(ethers.parseUnits("1000", 6));
      expect(await classA.totalSupply()).to.equal(ethers.parseUnits("2000", 6));
    });
    
    it("Should initialize dividend tracking on deposit", async function () {
      await fundVault.connect(lp1).deposit(ethers.parseUnits("1000", 6), true);
      
      const claimed = await fundVault.dividendsPerShareClaimed(
        lp1.address,
        await classA.getAddress()
      );
      expect(claimed).to.equal(await fundVault.dividendsPerShare());
    });
  });
  
  describe("Investments", function () {
    beforeEach(async function () {
      await fundVault.connect(lp1).deposit(ethers.parseUnits("1000", 6), true);
    });
    
    it("Should execute investment and transfer USDC", async function () {
      const amount = ethers.parseUnits("500", 6);
      await fundVault.executeInvestment(company.address, amount, 1500);
      
      expect(await usdc.balanceOf(company.address)).to.equal(amount);
      expect(await fundVault.totalDeployed()).to.equal(amount);
    });
    
    it("Should track investment details", async function () {
      const amount = ethers.parseUnits("500", 6);
      await fundVault.executeInvestment(company.address, amount, 1500);
      
      const inv = await fundVault.getInvestment(0);
      expect(inv.target).to.equal(company.address);
      expect(inv.amount).to.equal(amount);
      expect(inv.equityPercent).to.equal(1500);
      expect(inv.exited).to.be.false;
    });
    
    it("Should revert if insufficient balance", async function () {
      await expect(
        fundVault.executeInvestment(
          company.address,
          ethers.parseUnits("2000", 6),
          1500
        )
      ).to.be.revertedWith("Insufficient balance");
    });
  });
  
  describe("Returns & Exits", function () {
    beforeEach(async function () {
      await fundVault.connect(lp1).deposit(ethers.parseUnits("1000", 6), true);
      await fundVault.executeInvestment(
        company.address,
        ethers.parseUnits("500", 6),
        1500
      );
      
      // Company returns 750 (150 profit)
      await usdc.mint(company.address, ethers.parseUnits("750", 6));
      await usdc.connect(company).transfer(
        await fundVault.getAddress(),
        ethers.parseUnits("750", 6)
      );
    });
    
    it("Should record exit and decrease totalDeployed", async function () {
      await fundVault.recordReturn(0, ethers.parseUnits("750", 6));
      
      const inv = await fundVault.getInvestment(0);
      expect(inv.exited).to.be.true;
      expect(inv.returnAmount).to.equal(ethers.parseUnits("750", 6));
      expect(await fundVault.totalDeployed()).to.equal(0); // Was 500, now 0
    });
    
    it("Should calculate and transfer carry (20%)", async function () {
      const balanceBefore = await usdc.balanceOf(owner.address);
      await fundVault.recordReturn(0, ethers.parseUnits("750", 6));
      const balanceAfter = await usdc.balanceOf(owner.address);
      
      // Profit = 750 - 500 = 250
      // Carry = 250 * 20% = 50
      expect(balanceAfter - balanceBefore).to.equal(ethers.parseUnits("50", 6));
    });
    
    it("Should not transfer carry if no profit", async function () {
      // Return only 400 (loss)
      await fundVault.recordReturn(0, ethers.parseUnits("400", 6));
      
      const balance = await usdc.balanceOf(owner.address);
      expect(balance).to.equal(0);
    });
  });
  
  describe("Dividends", function () {
    beforeEach(async function () {
      await fundVault.connect(lp1).deposit(ethers.parseUnits("1000", 6), true);
      await fundVault.connect(lp2).deposit(ethers.parseUnits("1000", 6), false);
    });
    
    it("Should distribute dividends proportionally", async function () {
      await fundVault.distributeDividends(ethers.parseUnits("200", 6));
      
      const pending1 = await fundVault.viewPendingDividends(lp1.address, true);
      const pending2 = await fundVault.viewPendingDividends(lp2.address, false);
      
      // 200 / 2000 shares = 0.1 per share
      // 1000 shares each = 100 each
      expect(pending1).to.equal(ethers.parseUnits("100", 6));
      expect(pending2).to.equal(ethers.parseUnits("100", 6));
    });
    
    it("Should allow LPs to claim dividends", async function () {
      await fundVault.distributeDividends(ethers.parseUnits("200", 6));
      
      const balanceBefore = await usdc.balanceOf(lp1.address);
      await fundVault.connect(lp1).claimDividends(true);
      const balanceAfter = await usdc.balanceOf(lp1.address);
      
      expect(balanceAfter - balanceBefore).to.equal(ethers.parseUnits("100", 6));
    });
    
    it("Should track claimed dividends separately per share class", async function () {
      // LP holds both A and B shares
      await fundVault.connect(lp1).deposit(ethers.parseUnits("500", 6), false);
      
      await fundVault.distributeDividends(ethers.parseUnits("250", 6));
      
      // Claim from Class A
      await fundVault.connect(lp1).claimDividends(true);
      
      // Should still have pending from Class B
      const pendingB = await fundVault.viewPendingDividends(lp1.address, false);
      expect(pendingB).to.be.gt(0);
    });
    
    it("Should prevent double-claiming after redeem and re-deposit", async function () {
      await fundVault.distributeDividends(ethers.parseUnits("200", 6));
      
      // Claim dividends
      await fundVault.connect(lp1).claimDividends(true);
      
      // Redeem all shares
      const shares = await classA.balanceOf(lp1.address);
      await fundVault.connect(lp1).redeem(shares, true);
      
      // Re-deposit
      await fundVault.connect(lp1).deposit(ethers.parseUnits("500", 6), true);
      
      // Should have 0 pending (not historical dividends)
      const pending = await fundVault.viewPendingDividends(lp1.address, true);
      expect(pending).to.equal(0);
    });
  });
  
  describe("Redemptions", function () {
    beforeEach(async function () {
      await fundVault.connect(lp1).deposit(ethers.parseUnits("1000", 6), true);
      await fundVault.connect(lp2).deposit(ethers.parseUnits("1000", 6), true);
    });
    
    it("Should redeem shares for proportional USDC", async function () {
      const shares = ethers.parseUnits("500", 6);
      const balanceBefore = await usdc.balanceOf(lp1.address);
      
      await fundVault.connect(lp1).redeem(shares, true);
      
      const balanceAfter = await usdc.balanceOf(lp1.address);
      
      // 500 shares / 2000 total = 25% of vault
      // 25% of 2000 USDC = 500 USDC
      expect(balanceAfter - balanceBefore).to.equal(ethers.parseUnits("500", 6));
    });
    
    it("Should burn redeemed shares", async function () {
      const shares = ethers.parseUnits("500", 6);
      await fundVault.connect(lp1).redeem(shares, true);
      
      expect(await classA.balanceOf(lp1.address)).to.equal(ethers.parseUnits("500", 6));
      expect(await classA.totalSupply()).to.equal(ethers.parseUnits("1500", 6));
    });
  });
  
  describe("NAV & Fund Stats", function () {
    it("Should calculate NAV per share correctly", async function () {
      await fundVault.connect(lp1).deposit(ethers.parseUnits("1000", 6), true);
      
      let nav = await fundVault.navPerShare();
      expect(nav).to.equal(ethers.parseEther("1")); // 1:1 initially
      
      // Invest 500
      await fundVault.executeInvestment(
        company.address,
        ethers.parseUnits("500", 6),
        1500
      );
      
      // NAV should still be 1:1 (AUM includes deployed capital)
      nav = await fundVault.navPerShare();
      expect(nav).to.equal(ethers.parseEther("1"));
    });
    
    it("Should return accurate fund stats", async function () {
      await fundVault.connect(lp1).deposit(ethers.parseUnits("1000", 6), true);
      await fundVault.executeInvestment(
        company.address,
        ethers.parseUnits("500", 6),
        1500
      );
      
      const stats = await fundVault.fundStats();
      expect(stats.totalAUM).to.equal(ethers.parseUnits("1000", 6));
      expect(stats.deployed).to.equal(ethers.parseUnits("500", 6));
      expect(stats.available).to.equal(ethers.parseUnits("500", 6));
    });
  });
  
  describe("Management Fees", function () {
    it("Should collect 2% annual management fee", async function () {
      await fundVault.connect(lp1).deposit(ethers.parseUnits("10000", 6), true);
      
      // Fast forward 1 year
      await ethers.provider.send("evm_increaseTime", [365 * 24 * 60 * 60]);
      await ethers.provider.send("evm_mine");
      
      const balanceBefore = await usdc.balanceOf(owner.address);
      await fundVault.collectManagementFee();
      const balanceAfter = await usdc.balanceOf(owner.address);
      
      // 2% of 10000 = 200
      expect(balanceAfter - balanceBefore).to.be.closeTo(
        ethers.parseUnits("200", 6),
        ethers.parseUnits("1", 6) // 1 USDC tolerance
      );
    });
  });
});
