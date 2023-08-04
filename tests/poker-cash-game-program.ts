import * as anchor from "@coral-xyz/anchor";
import { deserialize } from "borsh";
import { Program } from "@coral-xyz/anchor";
import { PokerCashGameProgram } from "../target/types/poker_cash_game_program";
import {
  SystemInstruction,
  PublicKey,
  Transaction,
  SystemProgram,
  Signer,
} from "@solana/web3.js";
import {
  createAssociatedTokenAccount,
  createMint,
  mintTo,
  getOrCreateAssociatedTokenAccount,
} from "@solana/spl-token";
import { describe, it } from "mocha";
import chai from "chai";
import chaiAsPromised from "chai-as-promised";
chai.use(chaiAsPromised);
const expect = chai.expect;

enum GameStatus {
  Active,
  Inactive,
}

const MY_PROGRAM_ID = new PublicKey(
  "4nfLZgvozjW9VPmYwpJ6f7gjncrX5tgiLNJcobSfybsn"
);

// Configure the client to use the local cluster.
anchor.setProvider(anchor.AnchorProvider.env());

const program = anchor.workspace
  .PokerCashGameProgram as Program<PokerCashGameProgram>;
const connection = anchor.getProvider().connection;

const createGame = async (
  data: Partial<{
    minDeposit: anchor.BN;
    maxDeposit: anchor.BN;
    maxPlayers: number;
  }> = {}
) => {
  const payer = anchor.web3.Keypair.generate();
  const gameAccount = anchor.web3.Keypair.generate();
  // Specify the rent-exempt reserve to fund the account creation
  const airdropTx = await connection.requestAirdrop(
    payer.publicKey,
    2000000000
  );
  await connection.confirmTransaction(airdropTx);
  const decimals = 9;
  const mint = await createMint(
    connection,
    payer,
    payer.publicKey,
    null,
    decimals
  );
  const [pda, bump] = PublicKey.findProgramAddressSync(
    [gameAccount.publicKey.toBuffer()],
    MY_PROGRAM_ID
  );
  const tokenAccount = await getOrCreateAssociatedTokenAccount(
    connection,
    payer,
    mint,
    pda,
    true
  );
  // Add your test here.
  await program.methods
    .createCashGame({
      maxDeposit: new anchor.BN(200 * Math.pow(10, decimals)),
      maxPlayers: 8,
      minDeposit: new anchor.BN(100 * Math.pow(10, decimals)),
      ...data,
    })
    .accounts({
      gameAccount: gameAccount.publicKey,
      payer: payer.publicKey,
      tokenAccount: tokenAccount.address,
    })
    .signers([payer, gameAccount])
    .rpc();

  return { payer, gameAccount, mint, tokenAccount };
};

interface JoinGameArgs {
  mint: PublicKey;
  payer: Signer;
  amount: number;
  gameAccount: PublicKey;
  tokenAccount: PublicKey;
}

const joinGame = async (req: JoinGameArgs) => {
  const { mint, payer, amount, gameAccount, tokenAccount } = req;
  const player = anchor.web3.Keypair.generate();
  const airdropTx = await connection.requestAirdrop(
    player.publicKey,
    2000000000
  );
  await connection.confirmTransaction(airdropTx);
  const playerTokenAccount = await getOrCreateAssociatedTokenAccount(
    connection,
    player,
    mint,
    player.publicKey,
    true
  );
  await mintTo(
    connection,
    player,
    mint,
    playerTokenAccount.address,
    payer,
    amount
  );
  const tx = await program.methods
    .joinGame({
      amount: new anchor.BN(amount),
    })
    .accounts({
      gameAccount: gameAccount,
      gameTokenAccount: tokenAccount,
      playerTokenAccount: playerTokenAccount.address,
      player: player.publicKey,
    })
    .signers([player])
    .rpc();

  return { player, playerTokenAccount };
};

describe("poker-cash-game-program", () => {
  it("Creates Game", async () => {
    const { gameAccount, payer } = await createGame();
    const { data } = await connection.getAccountInfo(gameAccount.publicKey);
    const gameState = program.coder.accounts.decode("GameAccount", data);
    expect(gameState.owner).to.eql(payer.publicKey);
    expect(gameState.players.length).to.eq(0);
  });

  describe("Join Game", () => {
    it("happy path", async () => {
      const amount = 200 * Math.pow(10, 9);
      const { gameAccount, tokenAccount, mint, payer } = await createGame();
      const { player } = await joinGame({
        amount,
        gameAccount: gameAccount.publicKey,
        mint,
        payer,
        tokenAccount: tokenAccount.address,
      });
      const { data } = await connection.getAccountInfo(gameAccount.publicKey);
      const gameState = program.coder.accounts.decode("GameAccount", data);
      expect(gameState.players.length).to.eq(1);
      expect(gameState.players[0].address).to.eql(player.publicKey);
      expect(gameState.players[0].balance.toNumber()).to.eql(
        new anchor.BN(amount).toNumber()
      );
    });

    it("fails when deposits are wrong amounts", async () => {
      const amount = 200 * Math.pow(10, 9);
      const { gameAccount, tokenAccount, mint, payer } = await createGame();
      await expect(
        joinGame({
          amount: amount + 1,
          gameAccount: gameAccount.publicKey,
          mint,
          payer,
          tokenAccount: tokenAccount.address,
        })
      ).to.eventually.rejected;
      await expect(
        joinGame({
          amount: 100 * Math.pow(10, 9) - 1,
          gameAccount: gameAccount.publicKey,
          mint,
          payer,
          tokenAccount: tokenAccount.address,
        })
      ).to.eventually.rejected;
    });

    it("fails if table is full", async () => {
      const { gameAccount, tokenAccount, mint, payer } = await createGame({
        maxPlayers: 2,
      });
      await joinGame({
        amount: 200 * Math.pow(10, 9),
        gameAccount: gameAccount.publicKey,
        mint,
        payer,
        tokenAccount: tokenAccount.address,
      });
      await joinGame({
        amount: 200 * Math.pow(10, 9),
        gameAccount: gameAccount.publicKey,
        mint,
        payer,
        tokenAccount: tokenAccount.address,
      });
      await expect(
        joinGame({
          amount: 200 * Math.pow(10, 9),
          gameAccount: gameAccount.publicKey,
          mint,
          payer,
          tokenAccount: tokenAccount.address,
        })
      ).to.eventually.rejected;
    });
  });

  it("sets game status", async () => {
    const { gameAccount, payer } = await createGame();
    await program.methods
      .setGameStatus({ status: { active: {} } })
      .accounts({
        gameAccount: gameAccount.publicKey,
        payer: payer.publicKey,
      })
      .signers([payer])
      .rpc();
    const { data } = await connection.getAccountInfo(gameAccount.publicKey);
    const gameState = program.coder.accounts.decode("GameAccount", data);
    expect(!!gameState.status.active).to.eq(true);
    const badPayer = anchor.web3.Keypair.generate();
    const airdropTx = await connection.requestAirdrop(
      badPayer.publicKey,
      2000000000
    );
    await connection.confirmTransaction(airdropTx);
    await expect(
      program.methods
        .setGameStatus({ status: { active: {} } })
        .accounts({
          gameAccount: gameAccount.publicKey,
          payer: badPayer.publicKey,
        })
        .signers([payer])
        .rpc()
    ).to.eventually.rejected;
  });

  describe("Add Chips", () => {
    it("happy path add chips and game inactive", async () => {
      const { gameAccount, payer, tokenAccount, mint } = await createGame();
      const { player, playerTokenAccount } = await joinGame({
        amount: 100 * Math.pow(10, 9),
        gameAccount: gameAccount.publicKey,
        mint,
        payer,
        tokenAccount: tokenAccount.address,
      });

      await mintTo(
        connection,
        payer,
        mint,
        playerTokenAccount.address,
        payer,
        100 * Math.pow(10, 9)
      );
      await program.methods
        .addChips({ amount: new anchor.BN(100 * Math.pow(10, 9)) })
        .accounts({
          gameAccount: gameAccount.publicKey,
          gameTokenAccount: tokenAccount.address,
          owner: player.publicKey,
          playerTokenAccount: playerTokenAccount.address,
        })
        .signers([player])
        .rpc();
      const { data } = await connection.getAccountInfo(gameAccount.publicKey);
      const gameState = program.coder.accounts.decode("GameAccount", data);
      expect(gameState.players[0].balance.toNumber()).to.eq(
        200 * Math.pow(10, 9)
      );
    });

    it("happy path add chips and game active", async () => {
      const { gameAccount, payer, tokenAccount, mint } = await createGame();
      const { player, playerTokenAccount } = await joinGame({
        amount: 100 * Math.pow(10, 9),
        gameAccount: gameAccount.publicKey,
        mint,
        payer,
        tokenAccount: tokenAccount.address,
      });
      await program.methods
        .setGameStatus({ status: { active: {} } })
        .accounts({
          gameAccount: gameAccount.publicKey,
          payer: payer.publicKey,
        })
        .signers([payer])
        .rpc();
      await mintTo(
        connection,
        payer,
        mint,
        playerTokenAccount.address,
        payer,
        100 * Math.pow(10, 9)
      );
      await program.methods
        .addChips({ amount: new anchor.BN(100 * Math.pow(10, 9)) })
        .accounts({
          gameAccount: gameAccount.publicKey,
          gameTokenAccount: tokenAccount.address,
          owner: player.publicKey,
          playerTokenAccount: playerTokenAccount.address,
        })
        .signers([player])
        .rpc();
      const { data } = await connection.getAccountInfo(gameAccount.publicKey);
      const gameState = program.coder.accounts.decode("GameAccount", data);
      expect(gameState.players[0].balance.toNumber()).to.eq(
        100 * Math.pow(10, 9)
      );
      expect(gameState.players[0].addOn.toNumber()).to.eq(
        100 * Math.pow(10, 9)
      );
    });
  });

  describe("Settle", () => {
    it("happy path add and subtract, and remove", async () => {
      const { gameAccount, tokenAccount, mint, payer } = await createGame();
      const { player: player1 } = await joinGame({
        amount: 200 * Math.pow(10, 9),
        gameAccount: gameAccount.publicKey,
        mint,
        payer,
        tokenAccount: tokenAccount.address,
      });
      const { player: player2 } = await joinGame({
        amount: 200 * Math.pow(10, 9),
        gameAccount: gameAccount.publicKey,
        mint,
        payer,
        tokenAccount: tokenAccount.address,
      });
      const { player: player3, playerTokenAccount: player3TokenAccount } =
        await joinGame({
          amount: 200 * Math.pow(10, 9),
          gameAccount: gameAccount.publicKey,
          mint,
          payer,
          tokenAccount: tokenAccount.address,
        });
      const { value: initialValue } = await connection.getTokenAccountBalance(
        player3TokenAccount.address
      );
      expect(parseInt(initialValue.amount)).eq(0);
      const [pda, bump] = await PublicKey.findProgramAddressSync(
        [gameAccount.publicKey.toBuffer()],
        MY_PROGRAM_ID
      );
      await program.methods
        .setGameStatus({ status: { active: {} } })
        .accounts({
          gameAccount: gameAccount.publicKey,
          payer: payer.publicKey,
        })
        .signers([payer])
        .rpc();
      const tx = await program.methods
        .settle({
          settles: [
            {
              addr: player1.publicKey,
              op: { add: { "0": new anchor.BN(10 * Math.pow(10, 9)) } },
            },
            {
              addr: player2.publicKey,
              op: { sub: { "0": new anchor.BN(10 * Math.pow(10, 9)) } },
            },
          ],
        })

        .accounts({
          gameAccount: gameAccount.publicKey,
          payer: payer.publicKey,
          pdaAccount: pda,
          tokenAccount: tokenAccount.address,
        })
        .remainingAccounts([
          {
            isSigner: false,
            isWritable: true,
            pubkey: player3TokenAccount.address,
          },
        ])
        .signers([payer])
        .rpc();
      const { data } = await connection.getAccountInfo(gameAccount.publicKey);
      const gameState = program.coder.accounts.decode("GameAccount", data);
      expect(gameState.players[0].balance.toNumber()).to.eq(
        (200 + 10) * Math.pow(10, 9)
      );
      expect(gameState.players[1].balance.toNumber()).to.eq(
        (200 - 10) * Math.pow(10, 9)
      );
      expect(gameState.players.length).to.eq(2);
      const { value } = await connection.getTokenAccountBalance(
        player3TokenAccount.address
      );
      expect(parseInt(value.amount)).eq(200 * Math.pow(10, 9));
    });

    it("just removes a player", async () => {
      const { gameAccount, tokenAccount, mint, payer } = await createGame();
      const { player, playerTokenAccount } = await joinGame({
        amount: 200 * Math.pow(10, 9),
        gameAccount: gameAccount.publicKey,
        mint,
        payer,
        tokenAccount: tokenAccount.address,
      });
      const [pda, bump] = await PublicKey.findProgramAddressSync(
        [gameAccount.publicKey.toBuffer()],
        MY_PROGRAM_ID
      );
      await program.methods
        .setGameStatus({ status: { active: {} } })
        .accounts({
          gameAccount: gameAccount.publicKey,
          payer: payer.publicKey,
        })
        .signers([payer])
        .rpc();
      const tx = await program.methods
        .settle({
          settles: [],
        })

        .accounts({
          gameAccount: gameAccount.publicKey,
          payer: payer.publicKey,
          pdaAccount: pda,
          tokenAccount: tokenAccount.address,
        })
        .remainingAccounts([
          {
            isSigner: false,
            isWritable: true,
            pubkey: playerTokenAccount.address,
          },
        ])
        .signers([payer])
        .rpc();
      const { data } = await connection.getAccountInfo(gameAccount.publicKey);
      const gameState = program.coder.accounts.decode("GameAccount", data);
      expect(gameState.players.length).to.eq(0);
    });
  });

  describe.only("Close Game", () => {
    it("happy path", async () => {
      const { gameAccount, payer, tokenAccount, mint } = await createGame();
      const [pda, bump] = await PublicKey.findProgramAddressSync(
        [gameAccount.publicKey.toBuffer()],
        MY_PROGRAM_ID
      );
      const payerTokenAccount = await createAssociatedTokenAccount(
        connection,
        payer,
        mint,
        payer.publicKey
      );
      await program.methods
        .closeGame()
        .accounts({
          gameAccount: gameAccount.publicKey,
          gameTokenAccount: tokenAccount.address,
          payer: payer.publicKey,
          payerTokenAccount,
          pdaAccount: pda,
        })
        .signers([payer])
        .rpc();

      const ret = await connection.getAccountInfo(gameAccount.publicKey);
      const ret2 = await connection.getAccountInfo(tokenAccount.address);
      expect(ret).to.eq(null);
      expect(ret2).to.eq(null);
    });
  });
});
