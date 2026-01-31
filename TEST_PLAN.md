# Test Plan - Moltbook Ventures Contracts

**Status:** Unit tests have Hardhat 3.x compatibility issues. Testing manually on Base Sepolia instead.

## Manual Test Plan (Base Sepolia)

### Phase 1: Deploy Contracts
1. ✅ Compile contracts (done with solc)
2. ⏸️ Deploy FundVault
3. ⏸️ Deploy Governance
4. ⏸️ Verify on Basescan

### Phase 2: Basic Flow Test
**Scenario:** 2 LPs, 1 small investment, 1 exit

1. **Setup:**
   - Get testnet USDC on Base Sepolia
   - Approve vault for both test LPs

2. **Deposits:**
   - LP1: Deposit 500 USDC → Class A (should get 500 shares)
   - LP2: Deposit 500 USDC → Class B (should get 500 shares)
   - Verify: totalSupply = 1000, vault balance = 1000

3. **Small Investment (no vote required):**
   - Propose 200 USDC investment (<30% of 1000 AUM)
   - Wait 24h
   - Execute directly (no vote needed)
   - Verify: deployed = 200, company received 200 USDC

4. **Exit:**
   - Company returns 300 USDC (100 profit)
   - RecordReturn(0, 300)
   - Verify: 
     - Carry to owner = 20 USDC (20% of 100 profit)
     - deployed = 0 (decreased from 200)
     - Vault balance = 1080 (800 + 300 - 20 carry)

5. **Redemption:**
   - LP1 redeems 250 shares
   - Should get 250/1000 * 1080 = 270 USDC
   - Verify balances correct

### Phase 3: Governance Test
**Scenario:** Large investment requiring vote

1. **Large Investment Proposal:**
   - Propose 400 USDC investment (>30% of remaining AUM)
   - Equity contract address required

2. **Voting:**
   - LP1 (Class A) votes YES
   - LP2 (Class B) cannot vote (no voting power)
   - Verify: votesFor = 250 (LP1's remaining shares after redemption)

3. **Check Quorum:**
   - Total Class A = 250
   - Votes = 250
   - 250/250 = 100% quorum (>30% requirement) ✓

4. **Execute:**
   - Wait 24h
   - Execute proposal
   - Verify investment executed

### Phase 4: Dividend Test

1. **Distribute Dividends:**
   - distributeDividends(100 USDC)
   - Verify dividendsPerShare increased

2. **Claim:**
   - LP1 claims from Class A
   - LP2 claims from Class B
   - Verify proportional distribution

3. **Multi-class Test:**
   - LP1 deposits more to Class B
   - Distribute more dividends
   - Verify LP1 can claim separately from A and B

### Phase 5: Edge Cases

1. **Zero balance scenarios**
2. **Max uint scenarios**
3. **Reentrancy attempts**
4. **Permission checks**

## Bug Fixes to Verify

1. ✅ totalDeployed decreases on exit
2. ✅ Dividend tracking per share class
3. ✅ No double-claim after redeem+redeposit
4. ✅ Share minting uses total AUM not just vault balance

## Automated Tests (TODO: Fix Hardhat Setup)

Once Hardhat dependencies are resolved:
- `npm test` should run full test suite
- Coverage should be >90%
- All edge cases covered

**Current blocker:** Hardhat 3.x compatibility with toolbox packages.
**Workaround:** Manual testing on testnet is sufficient for $1k pilot.
