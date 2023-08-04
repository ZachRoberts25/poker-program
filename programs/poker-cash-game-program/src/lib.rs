use anchor_lang::prelude::*;
use anchor_spl::token::{transfer, Transfer};
pub mod errors;
pub use errors::PokerError;
pub mod state;
pub use state::*;
declare_id!("4nfLZgvozjW9VPmYwpJ6f7gjncrX5tgiLNJcobSfybsn");

#[program]
pub mod poker_cash_game_program {

    use anchor_spl::{
        associated_token::get_associated_token_address,
        token::{close_account, CloseAccount},
    };

    use super::*;

    pub fn create_cash_game(ctx: Context<CreateGameParams>, data: CreateGameData) -> Result<()> {
        let game_account = &mut ctx.accounts.game_account;
        let token_account = &mut ctx.accounts.token_account;
        let (pda, _bump_seed) =
            Pubkey::find_program_address(&[game_account.key().as_ref()], ctx.program_id);
        if token_account.owner != pda {
            return Err(PokerError::IncorrectTokenOwner.into());
        }
        if token_account.amount != 0 {
            return Err(PokerError::InitialTokenAccountBalanceNonZero.into());
        }
        msg!(
            "Creating game account with max players: {:?}",
            data.max_players
        );
        game_account.max_players = data.max_players;
        game_account.min_deposit = data.min_deposit;
        game_account.max_deposit = data.max_deposit;
        game_account.owner = *ctx.accounts.payer.key;
        game_account.status = GameStatus::Inactive;
        game_account.players = Box::new(Vec::<SeatedPlayer>::with_capacity(
            data.max_players as usize,
        ));
        Ok(())
    }

    pub fn join_game(ctx: Context<JoinGame>, data: JoinGameArgs) -> Result<()> {
        let game_account = &mut ctx.accounts.game_account;
        let game_token_account = &mut ctx.accounts.game_token_account;
        let player_token_account = &mut ctx.accounts.player_token_account;
        let token_program = &ctx.accounts.token_program;
        let player = &ctx.accounts.player;
        let (pda, _bump_seed) =
            Pubkey::find_program_address(&[game_account.key().as_ref()], ctx.program_id);
        if game_token_account.owner != pda {
            return Err(PokerError::IncorrectTokenOwner.into());
        }
        if game_account.players.len() == (game_account.max_players as usize) {
            return Err(PokerError::GameFull.into());
        }
        if data.amount < game_account.min_deposit {
            return Err(PokerError::DepositTooSmall.into());
        }
        if data.amount > game_account.max_deposit {
            return Err(PokerError::DepositTooLarge.into());
        }
        if game_account
            .players
            .iter()
            .any(|p| p.address == player.key())
        {
            return Err(PokerError::AlreadyAtTable.into());
        }
        let cpi_accounts = Transfer {
            from: player_token_account.to_account_info().clone(),
            to: game_token_account.to_account_info().clone(),
            authority: player.to_account_info().clone(),
        };
        let cpi_program = token_program.to_account_info();
        transfer(CpiContext::new(cpi_program, cpi_accounts), data.amount)?;
        game_account.players.push(SeatedPlayer {
            address: player.key(),
            balance: data.amount,
            add_on: 0,
        });
        Ok(())
    }

    pub fn set_game_status(ctx: Context<SetGameStatus>, data: GameStatusData) -> Result<()> {
        let game_account = &mut ctx.accounts.game_account;
        let payer = &ctx.accounts.payer;
        if game_account.owner != *payer.key {
            return Err(PokerError::NotGameOwner.into());
        }
        game_account.status = data.status;
        Ok(())
    }

    pub fn add_chips(ctx: Context<AddChips>, data: AddChipsData) -> Result<()> {
        let game_account = &mut ctx.accounts.game_account;
        let game_token_account = &mut ctx.accounts.game_token_account;
        let player_token_account = &mut ctx.accounts.player_token_account;
        let token_program = &ctx.accounts.token_program;
        let player = &ctx.accounts.owner;
        let (pda, _bump_seed) =
            Pubkey::find_program_address(&[game_account.key().as_ref()], ctx.program_id);
        if game_account
            .players
            .iter()
            .all(|p| p.address != player.key())
        {
            return Err(PokerError::NotAtTable.into());
        }
        if game_token_account.owner != pda {
            return Err(PokerError::IncorrectTokenOwner.into());
        }
        if data.amount > game_account.max_deposit {
            return Err(PokerError::DepositTooLarge.into());
        }
        let cpi_accounts = Transfer {
            from: player_token_account.to_account_info().clone(),
            to: game_token_account.to_account_info().clone(),
            authority: player.to_account_info().clone(),
        };
        let cpi_program = token_program.to_account_info();
        transfer(CpiContext::new(cpi_program, cpi_accounts), data.amount)?;
        if game_account.status == GameStatus::Active {
            game_account
                .players
                .iter_mut()
                .find(|p| p.address == player.key())
                .unwrap()
                .add_on += data.amount;
        } else {
            game_account
                .players
                .iter_mut()
                .find(|p| p.address == player.key())
                .unwrap()
                .balance += data.amount;
        }
        Ok(())
    }

    pub fn settle<'info>(
        ctx: Context<'_, '_, '_, 'info, SettleAccounts<'info>>,
        data: SettleParams,
    ) -> Result<()> {
        let game_account = &mut ctx.accounts.game_account;
        let game_token_account = &mut ctx.accounts.token_account;
        let token_program = &ctx.accounts.token_program;
        let pda_account = &mut ctx.accounts.pda_account;
        let settles = data.settles;
        let payer = &ctx.accounts.payer;
        if game_account.owner != *payer.key {
            return Err(PokerError::NotGameOwner.into());
        }
        if game_account.status != GameStatus::Active {
            return Err(PokerError::GameNotActive.into());
        }
        for settle in settles.into_iter() {
            match settle.op {
                SettleOp::Add(amt) => {
                    if let Some(player) = game_account
                        .players
                        .iter_mut()
                        .find(|p| p.address.key() == settle.addr.key())
                    {
                        player.balance = player
                            .balance
                            .checked_add(amt)
                            .ok_or(PokerError::DepositTooLarge)?;
                    } else {
                        return Err(PokerError::NotAtTable)?;
                    }
                }
                SettleOp::Sub(amt) => {
                    if let Some(player) = game_account
                        .players
                        .iter_mut()
                        .find(|p| p.address.key() == settle.addr.key())
                    {
                        player.balance = player
                            .balance
                            .checked_sub(amt)
                            .ok_or(PokerError::DepositTooLarge)?;
                    } else {
                        return Err(PokerError::NotAtTable)?;
                    }
                }
            }
        }

        let from = &mut game_token_account.to_account_info().clone();
        let authority = &mut pda_account.to_account_info().clone();
        let cpi_program: AccountInfo<'_> = token_program.to_account_info();
        let game_account_key = game_account.key();
        let (pda, _bump_seed) =
            Pubkey::find_program_address(&[game_account.key().as_ref()], ctx.program_id);
        let seed = game_account_key.as_ref();
        let players = game_account.players.clone();
        for player_token_account in ctx.remaining_accounts.into_iter() {
            if let Some(player) = game_account.players.iter_mut().find(|p| {
                get_associated_token_address(&p.address.key(), &game_token_account.mint.key())
                    == player_token_account.key()
            }) {
                let accounts = Transfer {
                    to: player_token_account.clone(),
                    authority: authority.clone(),
                    from: from.to_account_info().clone(),
                };
                transfer(
                    CpiContext::new_with_signer(
                        cpi_program.clone(),
                        accounts,
                        &[&[seed, &[_bump_seed]]],
                    ),
                    player.balance + player.add_on,
                )?;
                let idx = players
                    .iter()
                    .position(|p| p.address.key() == player.address.key())
                    .unwrap();
                game_account.players.remove(idx);
            } else {
                return Err(PokerError::NotAtTable)?;
            }
        }
        Ok(())
    }

    pub fn close_game(ctx: Context<CloseGame>) -> Result<()> {
        let game_account = &mut ctx.accounts.game_account;
        let game_token_account = &mut ctx.accounts.game_token_account;
        let payer_token_account = &mut ctx.accounts.payer_token_account;
        let pda_account = &mut ctx.accounts.pda_account;
        let token_program = &ctx.accounts.token_program;
        let payer = &ctx.accounts.payer;
        if game_account.owner != payer.key() {
            return Err(PokerError::NotGameOwner.into());
        }
        if game_account.players.len() > 0 {
            return Err(PokerError::PlayersStillAtTable.into());
        }
        let accounts = Transfer {
            to: payer_token_account.to_account_info().clone(),
            authority: pda_account.to_account_info().clone(),
            from: game_token_account.to_account_info().clone(),
        };
        let game_account_key = game_account.key();
        let seed = game_account_key.as_ref();
        let (pda, _bump_seed) =
            Pubkey::find_program_address(&[game_account.key().as_ref()], ctx.program_id);
        // this all the tokens left over from the game, basically the rake;
        if game_token_account.amount > 0 {
            transfer(
                CpiContext::new_with_signer(
                    token_program.to_account_info().clone(),
                    accounts,
                    &[&[seed, &[_bump_seed]]],
                ),
                game_token_account.amount,
            )?;
        }
        close_account(CpiContext::new_with_signer(
            token_program.to_account_info(),
            CloseAccount {
                account: game_token_account.to_account_info(),
                destination: payer.to_account_info(),
                authority: pda_account.to_account_info(),
            },
            &[&[seed, &[_bump_seed]]],
        ))?;
        let amount_of_lamports = game_account.to_account_info().lamports();
        **payer.to_account_info().try_borrow_mut_lamports()? += amount_of_lamports;
        **game_account.to_account_info().try_borrow_mut_lamports()? -= amount_of_lamports;
        Ok(())
    }
}
