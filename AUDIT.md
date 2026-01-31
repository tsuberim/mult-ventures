# Contract Audit - Moltbook Ventures

**Date:** 2026-01-31  
**Auditor:** Bob (AI Agent)  
**Scope:** FundVault.sol, Governance.sol

## Critical Issues

### 1. ❌ CRITICAL: totalDeployed not decreased on exits
**Location:** `FundVault.sol` - `recordReturn()`  
**Impact:** AUM calculations permanently inflated after exits

**Problem:**
```solidity
function recordReturn(uint256 investmentId, uint256 returnAmount) external onlyOwner {
    // ... records return
    totalReturns += returnAmount;
    // BUG: totalDeployed is never decreased!
}
```

When an investment exits, `totalDeployed` should decrease by the investment amount. Currently it stays inflated forever, making AUM calculations wrong:
- `fundStats()` returns incorrect AUM
- `navPerShare()` is inflated
- Governance threshold calculation (30% of AUM) uses wrong value

**Fix:**
```solidity
inv.exited = true;
inv.returnAmount = returnAmount;
totalDeployed -= inv.amount; // ADD THIS
totalReturns += returnAmount;
```

---

### 2. ❌ CRITICAL: Dividend tracking bug for LPs with both share classes
**Location:** `FundVault.sol` - `dividendsPerShareClaimed` mapping  
**Impact:** Incorrect dividend calculations if LP holds both Class A and Class B

**Problem:**
```solidity
mapping(address => uint256) public dividendsPerShareClaimed;
```

This is per-address, not per-share-class. If an LP holds both A and B shares:
1. Claims dividends from Class A → updates `dividendsPerShareClaimed[address]`
2. Claims dividends from Class B → uses the same `dividendsPerShareClaimed` value
3. Result: Wrong dividend calculation

**Fix:**
```solidity
// Separate tracking per share class
mapping(address => mapping(address => uint256)) public dividendsPerShareClaimed; // LP → ShareToken → claimed
```

And update all dividend functions to use `dividendsPerShareClaimed[msg.sender][address(shareToken)]`

---

### 3. ⚠️ HIGH: Dividend double-claim vulnerability
**Location:** `FundVault.sol` - `deposit()`  
**Impact:** LP can claim historical dividends after redeeming and re-depositing

**Problem:**
```solidity
if (dividendsPerShareClaimed[msg.sender] == 0) {
    dividendsPerShareClaimed[msg.sender] = dividendsPerShare;
}
```

Scenario:
1. LP deposits, gets shares
2. `dividendsPerShareClaimed[LP] = 100`
3. LP claims dividends, redeems all shares
4. **dividendsPerShareClaimed stays at 100** (not reset)
5. Dividends distributed, `dividendsPerShare` now 150
6. LP deposits again
7. Condition is false (claimed != 0), so LP can claim dividends from 100→150 again

**Fix:**
```solidity
// Always update to current level on deposit
dividendsPerShareClaimed[msg.sender][address(shareToken)] = dividendsPerShare;
```

---

## Medium Issues

### 4. ⚠️ MEDIUM: Share dilution after capital deployment
**Location:** `FundVault.sol` - `deposit()`  
**Impact:** Later LPs get unfair share dilution if vault has deployed capital

**Problem:**
```solidity
uint256 totalUSDC = usdc.balanceOf(address(this)); // Only vault balance, not total AUM
uint256 sharesToMint = (amount * totalShares) / totalUSDC;
```

Example:
- Fund has $1000, mints 1000 shares (1:1)
- Fund invests $900 (only $100 left in vault)
- New LP deposits $100
- `sharesToMint = (100 * 1000) / 100 = 1000 shares`
- New LP gets 50% ownership for 10% of capital!

**Fix:**
```solidity
uint256 totalAUM = usdc.balanceOf(address(this)) + totalDeployed;
uint256 sharesToMint = (amount * totalShares) / totalAUM;
```

---

## Low Issues

### 5. ℹ️ LOW: Dividend distribution doesn't segregate funds
**Location:** `FundVault.sol` - `distributeDividends()` + `claimDividends()`  
**Impact:** Potential confusion/conflicts with general vault operations

**Problem:**
- `distributeDividends()` marks dividends available but doesn't move USDC
- LPs claim from general vault balance
- Could conflict with management fees, investments, etc.

**Not urgent for pilot**, but for production consider:
- Separate dividend reserve accounting
- Or make dividends pull-based with explicit fund segregation

---

## Governance.sol

✅ **No critical issues found**

Minor notes:
- Dynamic threshold calculation looks correct
- Voting logic is sound
- Equity contract requirement is enforced

---

## Recommendations

**Before testnet deployment:**
1. Fix Critical issues #1 and #2 (required)
2. Fix High issue #3 (strongly recommended)
3. Fix Medium issue #4 (recommended for fairness)

**Before mainnet:**
4. Consider Low issue #5 (nice to have)
5. Add emergency pause mechanism
6. Add time-lock for sensitive operations
7. Get external security audit

**For $1k pilot:**
- Fixing 1-4 is sufficient
- Document known limitations
- Monitor closely for unexpected behavior

---

## Overall Assessment

**Security:** 🟡 Needs fixes before production  
**Logic:** 🟢 Core mechanics are sound  
**Readiness:** 🟡 Fix critical/high issues, then deploy to testnet

The contracts are well-structured but have accounting bugs that need fixing before handling real money.
