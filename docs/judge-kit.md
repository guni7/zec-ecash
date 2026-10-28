# Judge kit on mainnet

Claim links that give each judge real ecash on the mainnet mint, so they can try the wallet with
no ZEC of their own. A link is `https://zecmint.duckdns.org/#/claim/<token>`: opening it claims
the money into that browser and opens the judges' tour (`#/judges`). Each link works once.

Two ways to give them out:

- **Public** (`--public`): the tour page itself offers "Get 25,000 zats" (the link's amount) to
  anyone who opens https://zecmint.duckdns.org/#/judges, one link per browser, until the public
  links run out. The README points judges there, so nothing has to be sent to anyone. Anyone who
  finds the page can take one, and clearing a browser's storage gets another: the most it can
  give away is the public links' total.
- **Direct:** you send each judge their own link (message, QR code or printed page).

The money comes from the mint host's CLI wallet. Links you don't hand out, or that judges never
open, can be taken back afterwards.

Run everything on the main host, from `~/zec-ecash`, with the release CLI:

    cargo build --release -p zec-ecash-cli
    alias zcli='ZEC_NETWORK=mainnet ./target/release/zec-ecash-cli'

On mainnet the CLI reads `ZEC_MINT_URL` only from `mainnet/.env`, and keeps its seed in
`mainnet/keys/ecash-wallet.seed`. If that file doesn't exist yet: `zcli init`, then back up the
seed file.

## 1. Choose the amount

Each judge's link should cover the whole tour on mainnet:

- Sending and requesting move the money between the judge's own devices, so it isn't spent.
- **Cash out** (optional step) needs at least 10,000 zats plus the network fee (at least 10,000
  more) on one device: about 20,000 zats.

So 25,000 zats per judge is enough if they cash out from the device that claimed the link; more
leaves room for splitting it between devices first.

Total = judges × amount. Example: 10 judges × 25,000 = 250,000 zats (0.0025 ZEC).

## 2. Fund the CLI wallet

    zcli balance
    curl -s "https://zecmint.duckdns.org/deposit-quote?amount=250000"   # within the limits and the reserve cap?
    zcli deposit 250000

`deposit` prints a one-time address. Pay exactly that amount to it from any Zcash wallet; the CLI
waits for 10 confirmations (about 13 minutes) and mints. Each deposit is 10,000 to 1,000,000
zats, and the whole reserve stays under the reserve cap (`ZEC_MAX_RESERVE`, 1,000,000 zats by
default), so check the `deposit-quote` answer first.

## 3. Make the kit

`names.txt`: one judge per line, in order (blank lines are skipped; without it they are
"Judge 1", "Judge 2", …).

    zcli judge-kit create 10 25000 --public                # public: the tour hands them out
    zcli judge-kit create 10 25000 --names names.txt       # direct: one named link per judge

Both can be in one kit; only links made with `--public` are ever handed out by the tour. It refuses if the wallet holds less than the total. It writes `mainnet/judge-kit/` (mode 700;
every file mode 600, because each link is spendable money):

| File | What |
|---|---|
| `judge-NN-<name>.txt` | the link |
| `judge-NN-<name>.png` | its QR code |
| `judge-NN-<name>.pdf` | one printable page: name, QR code, link, the tour's steps |
| `kit.csv` | name, link, amount, created |
| `kit.json` | everything, including what `reclaim` needs |

Copy the files to your laptop with `scp -r` and keep them private. `mainnet/` is gitignored.

**Try one yourself first:** `zcli judge-kit create 1 10000`, open the link on your phone, check
the tour, and see `zcli judge-kit status` show it claimed (the 10,000 zats are now on your phone).
`create` adds to the same kit and numbers on from the last link, so the test
link stays listed, as claimed or reclaimed, and the judges' links start at the next number.

## 4. Hand them out

**Public links:** nothing to do. The point-of-sale server (`crates/pos`, already running on the
main host) reads `mainnet/judge-kit/kit.json` on every request, so new public links show up on
the tour at once. Check: `curl -s https://zecmint.duckdns.org/pos/judge/status` gives
`{"left": <links left>, "amount": <zats>}`. Before handing a link out the server asks the mint
whether it's still unspent, and the same browser asking again gets the same link back.

**Direct links:** one per judge, privately (a direct message, or the printed page). Anyone who
has a link can claim it. The claim page warns the judge once not to share it.

On iPhone, judges should open the link in Safari and stay there for the tour: a copy added to
the Home Screen starts with its own, empty wallet. The tour says so.

## 5. During judging

    zcli judge-kit status

One line per link: unclaimed, being claimed, claimed, or reclaimed, from the mint's proof states
(NUT-07). A judge who sees "already used" opened it before, or someone else did. Give them a spare
link, or make one more: `zcli judge-kit create 1 25000` adds it to the same kit.

## 6. Afterwards

    zcli judge-kit reclaim

Takes every unclaimed link's money back into the CLI wallet, public ones included (the tour then
stops offering them); those links then show "already used". Run it from the same CLI wallet that made the kit: it reclaims through that wallet's
record of each send. The ecash stays in the CLI wallet; cash it out with
`zcli withdraw <zat> <address> --confirm-mainnet` if you want the ZEC back.
