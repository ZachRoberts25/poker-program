use anchor_lang::prelude::*;

#[error_code]
pub enum PokerError {
    #[msg("Associated token account should be owned by PDA!")]
    IncorrectTokenOwner,
    #[msg("Associated token account should have a balance of zero")]
    InitialTokenAccountBalanceNonZero,
    #[msg("Not enough funds to join game")]
    NotEnoughFunds,
    #[msg("Game is full")]
    GameFull,
    #[msg("Already at table")]
    AlreadyAtTable,
    #[msg("Deposit too small")]
    DepositTooSmall,
    #[msg("Deposit too large")]
    DepositTooLarge,
    #[msg("Not Game Owner")]
    NotGameOwner,
    #[msg("Not At Table")]
    NotAtTable,
    #[msg("Game Not Active")]
    GameNotActive,
    #[msg("InvalidAddress")]
    InvalidAddress,
    #[msg("PlayersStillAtTable")]
    PlayersStillAtTable,
}
