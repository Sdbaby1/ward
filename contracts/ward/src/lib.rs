use near_sdk::store::{IterableMap, IterableSet};
use near_sdk::{env, near, require, AccountId, BorshStorageKey, NearToken, PanicOnDefault, Promise};

const REPORT_BLOCK_THRESHOLD: u64 = 3;

#[derive(BorshStorageKey)]
#[near(serializers = [borsh])]
enum StorageKey {
    Reports,
    Index,
    Blocked,
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct Report {
    pub reporter: AccountId,
    pub target: AccountId,
    pub reason: String,
    pub evidence: String,
    pub bond: NearToken,
    pub created_at_ms: u64,
    pub confirmed: bool,
}

#[near(serializers = [json])]
pub struct TargetView {
    pub target: AccountId,
    pub blocked: bool,
    pub owner_confirmed: bool,
    pub report_count: u64,
    pub reports: Vec<Report>,
}

#[near(serializers = [json])]
pub struct ConfigView {
    pub owner: AccountId,
    pub agent: AccountId,
    pub max_per_tx: NearToken,
    pub daily_limit: NearToken,
    pub spent_today: NearToken,
    pub min_bond: NearToken,
    pub bonded: NearToken,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Ward {
    owner: AccountId,
    agent: AccountId,
    max_per_tx: NearToken,
    daily_limit: NearToken,
    spent_today: NearToken,
    spent_day: u64,
    min_bond: NearToken,
    bonded: NearToken,
    reports: IterableMap<String, Report>,
    index: IterableMap<AccountId, Vec<String>>,
    blocked: IterableSet<AccountId>,
}

#[near]
impl Ward {
    #[init]
    pub fn new(
        owner: AccountId,
        agent: AccountId,
        max_per_tx: NearToken,
        daily_limit: NearToken,
        min_bond: NearToken,
    ) -> Self {
        require!(max_per_tx.as_yoctonear() > 0, "MAX_PER_TX");
        require!(
            daily_limit.as_yoctonear() >= max_per_tx.as_yoctonear(),
            "DAILY_LIMIT"
        );
        require!(min_bond.as_yoctonear() > 0, "MIN_BOND");
        Self {
            owner,
            agent,
            max_per_tx,
            daily_limit,
            spent_today: NearToken::from_yoctonear(0),
            spent_day: env::block_timestamp_ms() / 86_400_000,
            min_bond,
            bonded: NearToken::from_yoctonear(0),
            reports: IterableMap::new(StorageKey::Reports),
            index: IterableMap::new(StorageKey::Index),
            blocked: IterableSet::new(StorageKey::Blocked),
        }
    }

    pub fn get_config(&self) -> ConfigView {
        ConfigView {
            owner: self.owner.clone(),
            agent: self.agent.clone(),
            max_per_tx: self.max_per_tx,
            daily_limit: self.daily_limit,
            spent_today: self.spent_today,
            min_bond: self.min_bond,
            bonded: self.bonded,
        }
    }

    pub fn get_target(&self, target: AccountId) -> TargetView {
        let reports = self.reports_for(&target);
        TargetView {
            blocked: self.is_blocked(&target),
            owner_confirmed: self.blocked.contains(&target),
            report_count: reports.len() as u64,
            target,
            reports,
        }
    }

    #[payable]
    pub fn fund(&mut self) {}

    #[payable]
    pub fn report(&mut self, target: AccountId, reason: String, evidence: String) {
        let reporter = env::predecessor_account_id();
        require!(reporter != target, "SELF_REPORT");
        require!(reason.len() >= 8 && reason.len() <= 280, "REASON");
        require!(evidence_ok(&evidence), "EVIDENCE");
        let deposit = env::attached_deposit();
        require!(deposit >= self.min_bond, "BOND_TOO_SMALL");
        let key = report_key(&reporter, &target);
        require!(self.reports.get(&key).is_none(), "ALREADY_REPORTED");
        self.bonded = NearToken::from_yoctonear(
            self.bonded.as_yoctonear().saturating_add(deposit.as_yoctonear()),
        );
        let mut keys = self.index.get(&target).cloned().unwrap_or_default();
        keys.push(key.clone());
        self.index.insert(target.clone(), keys);
        self.reports.insert(
            key,
            Report {
                reporter,
                target,
                reason,
                evidence,
                bond: deposit,
                created_at_ms: env::block_timestamp_ms(),
                confirmed: false,
            },
        );
    }

    pub fn confirm(&mut self, reporter: AccountId, target: AccountId) {
        self.only_owner();
        let key = report_key(&reporter, &target);
        let mut report = self.reports.get(&key).cloned().expect("UNKNOWN_REPORT");
        report.confirmed = true;
        self.reports.insert(key, report);
        self.blocked.insert(target);
    }

    pub fn block_receiver(&mut self, target: AccountId) {
        self.only_owner();
        self.blocked.insert(target);
    }

    pub fn dismiss(&mut self, reporter: AccountId, target: AccountId) {
        self.only_owner();
        let key = report_key(&reporter, &target);
        let report = self.reports.remove(&key).expect("UNKNOWN_REPORT");
        if let Some(keys) = self.index.get(&target).cloned() {
            let remaining: Vec<String> = keys.into_iter().filter(|item| item != &key).collect();
            self.index.insert(target, remaining);
        }
        self.bonded = NearToken::from_yoctonear(
            self.bonded
                .as_yoctonear()
                .saturating_sub(report.bond.as_yoctonear()),
        );
        let _promise = Promise::new(report.reporter).transfer(report.bond);
    }

    pub fn pay(&mut self, receiver: AccountId, amount: NearToken) {
        require!(env::predecessor_account_id() == self.agent, "ONLY_AGENT");
        require!(env::attached_deposit().as_yoctonear() == 0, "NO_DEPOSIT");
        require!(amount.as_yoctonear() > 0, "AMOUNT");
        require!(amount <= self.max_per_tx, "MAX_PER_TX");
        require!(receiver != env::current_account_id(), "SELF_PAY");
        require!(!self.is_blocked(&receiver), "BLOCKED");
        self.roll_day();
        let next = self.spent_today.as_yoctonear().saturating_add(amount.as_yoctonear());
        require!(next <= self.daily_limit.as_yoctonear(), "DAILY_LIMIT");
        require!(self.liquid() >= amount.as_yoctonear(), "INSUFFICIENT_LIQUID");
        self.spent_today = NearToken::from_yoctonear(next);
        let _promise = Promise::new(receiver).transfer(amount);
    }

    pub fn withdraw(&mut self, amount: NearToken) {
        self.only_owner();
        require!(amount.as_yoctonear() > 0, "AMOUNT");
        require!(self.liquid() >= amount.as_yoctonear(), "INSUFFICIENT_LIQUID");
        let _promise = Promise::new(self.owner.clone()).transfer(amount);
    }
}

impl Ward {
    fn only_owner(&self) {
        require!(env::predecessor_account_id() == self.owner, "ONLY_OWNER");
    }

    fn is_blocked(&self, target: &AccountId) -> bool {
        self.blocked.contains(target) || self.reports_for(target).len() as u64 >= REPORT_BLOCK_THRESHOLD
    }

    fn reports_for(&self, target: &AccountId) -> Vec<Report> {
        let Some(keys) = self.index.get(target) else {
            return Vec::new();
        };
        keys.iter()
            .filter_map(|key| self.reports.get(key).cloned())
            .collect()
    }

    fn roll_day(&mut self) {
        let day = env::block_timestamp_ms() / 86_400_000;
        if day != self.spent_day {
            self.spent_day = day;
            self.spent_today = NearToken::from_yoctonear(0);
        }
    }

    fn liquid(&self) -> u128 {
        let balance = env::account_balance().as_yoctonear();
        let storage = env::storage_byte_cost().as_yoctonear().saturating_mul(u128::from(env::storage_usage()));
        let reserved = storage.saturating_add(self.bonded.as_yoctonear());
        balance.saturating_sub(reserved)
    }
}

fn report_key(reporter: &AccountId, target: &AccountId) -> String {
    format!("{reporter}:{target}")
}

fn evidence_ok(evidence: &str) -> bool {
    evidence.len() >= 32
        && evidence.len() <= 500
        && (evidence.starts_with("tx:") || evidence.starts_with("https://"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::VMContextBuilder;
    use near_sdk::testing_env;

    fn context(predecessor: &str, deposit_yocto: u128) {
        let mut builder = VMContextBuilder::new();
        builder
            .current_account_id("ward.testnet".parse().unwrap())
            .signer_account_id(predecessor.parse().unwrap())
            .predecessor_account_id(predecessor.parse().unwrap())
            .attached_deposit(NearToken::from_yoctonear(deposit_yocto))
            .account_balance(NearToken::from_near(40))
            .block_timestamp(1_700_000_000_000 * 1_000_000);
        testing_env!(builder.build());
    }

    fn init() -> Ward {
        Ward::new(
            "owner.testnet".parse().unwrap(),
            "owner.testnet".parse().unwrap(),
            NearToken::from_near(5),
            NearToken::from_near(20),
            NearToken::from_millinear(50),
        )
    }

    #[test]
    fn four_pays_use_the_daily_budget() {
        context("owner.testnet", 0);
        let mut contract = init();
        let merchant: AccountId = "merchant.testnet".parse().unwrap();
        contract.pay(merchant.clone(), NearToken::from_near(5));
        contract.pay(merchant.clone(), NearToken::from_near(5));
        contract.pay(merchant.clone(), NearToken::from_near(5));
        contract.pay(merchant, NearToken::from_near(5));
        assert_eq!(contract.get_config().spent_today, NearToken::from_near(20));
    }

    #[test]
    #[should_panic(expected = "DAILY_LIMIT")]
    fn the_fifth_pay_hits_the_daily_limit() {
        context("owner.testnet", 0);
        let mut contract = init();
        let merchant: AccountId = "merchant.testnet".parse().unwrap();
        contract.pay(merchant.clone(), NearToken::from_near(5));
        contract.pay(merchant.clone(), NearToken::from_near(5));
        contract.pay(merchant.clone(), NearToken::from_near(5));
        contract.pay(merchant.clone(), NearToken::from_near(5));
        contract.pay(merchant, NearToken::from_near(1));
    }

    #[test]
    #[should_panic(expected = "BLOCKED")]
    fn pay_rejects_an_owner_blocked_receiver() {
        context("owner.testnet", 0);
        let mut contract = init();
        contract.block_receiver("known-bad.testnet".parse().unwrap());
        contract.pay("known-bad.testnet".parse().unwrap(), NearToken::from_near(1));
    }

    #[test]
    #[should_panic(expected = "ONLY_AGENT")]
    fn pay_rejects_a_different_predecessor() {
        context("owner.testnet", 0);
        let mut contract = Ward::new(
            "owner.testnet".parse().unwrap(),
            "agent.testnet".parse().unwrap(),
            NearToken::from_near(5),
            NearToken::from_near(20),
            NearToken::from_millinear(50),
        );
        contract.pay("merchant.testnet".parse().unwrap(), NearToken::from_near(1));
    }

    #[test]
    fn an_owner_confirmation_blocks_the_receiver() {
        context("owner.testnet", NearToken::from_millinear(50).as_yoctonear());
        let mut contract = init();
        let evidence = "tx:demo9f3c0a7b1e8d4c2a6b5f0e1d9c8a7b6f5e4d3c2b1a0f9e8d7c6b5a4f3e2d1c0b";
        contract.report(
            "known-bad.testnet".parse().unwrap(),
            "Prompt injection drain fixture.".to_string(),
            evidence.to_string(),
        );
        let view = contract.get_target("known-bad.testnet".parse().unwrap());
        assert_eq!(view.report_count, 1);
        assert!(!view.blocked);
        contract.confirm(
            "owner.testnet".parse().unwrap(),
            "known-bad.testnet".parse().unwrap(),
        );
        let blocked = contract.get_target("known-bad.testnet".parse().unwrap());
        assert!(blocked.blocked);
        assert!(blocked.owner_confirmed);
    }

    #[test]
    fn three_distinct_reports_block_without_owner_confirmation() {
        let bond = NearToken::from_millinear(50).as_yoctonear();
        let evidence = "tx:demo9f3c0a7b1e8d4c2a6b5f0e1d9c8a7b6f5e4d3c2b1a0f9e8d7c6b5a4f3e2d1c0b";
        context("one.near", bond);
        let mut contract = init();
        for reporter in ["one.near", "two.near", "three.near"] {
            context(reporter, bond);
            contract.report(
                "known-bad.testnet".parse().unwrap(),
                "Independent evidence-backed report.".to_string(),
                evidence.to_string(),
            );
        }
        let view = contract.get_target("known-bad.testnet".parse().unwrap());
        assert_eq!(view.report_count, 3);
        assert!(view.blocked);
        assert!(!view.owner_confirmed);
    }

    #[test]
    #[should_panic(expected = "EVIDENCE")]
    fn report_requires_evidence() {
        context("owner.testnet", NearToken::from_millinear(50).as_yoctonear());
        let mut contract = init();
        contract.report(
            "known-bad.testnet".parse().unwrap(),
            "This reason is long enough.".to_string(),
            "too-short".to_string(),
        );
    }

    #[test]
    #[should_panic(expected = "ONLY_OWNER")]
    fn withdraw_rejects_the_agent_predecessor_when_it_is_not_the_owner() {
        context("agent.testnet", 0);
        let contract = Ward::new(
            "owner.testnet".parse().unwrap(),
            "agent.testnet".parse().unwrap(),
            NearToken::from_near(5),
            NearToken::from_near(20),
            NearToken::from_millinear(50),
        );
        // new() stored owner as the argument, not the predecessor.
        // The in-memory struct still has owner = owner.testnet, so withdraw fails.
        let mut contract = contract;
        contract.withdraw(NearToken::from_near(1));
    }
}
