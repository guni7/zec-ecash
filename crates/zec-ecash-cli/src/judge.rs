//! Judge kits: claim links for hackathon judges, paid from this CLI wallet's balance.
//!
//!   judge-kit create <count> <zat> [--names names.txt] [--base <url>]
//!   judge-kit status       # per link: claimed or not (NUT-07 checkstate of its proofs)
//!   judge-kit reclaim      # takes every unclaimed token back into this wallet
//!
//! Each link is <base>/#/claim/<token>: an unlocked, compact cashuB token in the URL fragment,
//! which browsers never send to a server. Single-use: once claimed (or reclaimed) the mint
//! refuses it. Files go to <state>/judge-kit/ (mainnet/judge-kit/ on MAINNET; gitignored), the
//! directory mode 700 and every file mode 600, since each link is spendable money:
//!   kit.json                 every link with its token and send operation id (for reclaim)
//!   kit.csv                  name, link, amount, created
//!   judge-NN-<name>.txt|.png|.pdf   the link; its QR code; a printable page with the tour
//! <base> defaults to the mint URL without its /mint suffix (the web wallet's address).
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
    str::FromStr,
};

use anyhow::{Context, Result, anyhow, bail, ensure};
use cdk::{
    nuts::{State as ProofState, Token},
    wallet::Wallet,
};
use serde_json::{Value, json};

use crate::tokens;

/// The tour steps printed on each judge's page (the web tour, #/judges, has the details).
pub const TOUR: [&str; 8] = [
    "Look at your balance.",
    "Send to yourself on a second device: Send > Show a code, scan it from the other device.",
    "Receive without internet: airplane mode, Receive > Receive without internet, pay it from the other device.",
    "Ask for an amount: Receive > Request an amount, pay it from the other device.",
    "Try shop mode: load the demo shop, charge a sale, export the receipt PDF.",
    "Check the backing: Is my money safe?",
    "Cash out to Zcash (optional): at least 10,000 zats to your Zcash wallet.",
    "Have ZEC? Add money (takes about 13 minutes; start it and carry on).",
];

pub async fn run(wallet: &Wallet, state_dir: &Path, mint_url: &str, args: &[&str]) -> Result<()> {
    let dir = state_dir.join("judge-kit");
    match args {
        ["create", count, zat, rest @ ..] => {
            let count: usize = count.parse().context("<count> must be a whole number")?;
            let zat: u64 = zat.parse().context("<zat> must be a whole number")?;
            ensure!((1..=500).contains(&count), "<count> must be 1 to 500");
            ensure!(zat > 0, "<zat> must be more than 0");
            let (mut names_file, mut base) = (None, None);
            let mut it = rest.iter();
            while let Some(a) = it.next() {
                match *a {
                    "--names" => names_file = Some(PathBuf::from(it.next().context("--names <file>")?)),
                    "--base" => base = Some(it.next().context("--base <url>")?.trim_end_matches('/').to_owned()),
                    _ => bail!("usage: judge-kit create <count> <zat> [--names names.txt] [--base <url>]"),
                }
            }
            let base = match base {
                Some(b) => b,
                None => default_base(mint_url)?,
            };
            let names = match names_file {
                Some(f) => fs::read_to_string(&f).with_context(|| format!("cannot read {}", f.display()))?.lines().map(str::trim).filter(|l| !l.is_empty()).map(str::to_owned).collect(),
                None => vec![],
            };
            create(wallet, &dir, &base, count, zat, &names).await
        }
        ["status"] => status(wallet, &dir).await,
        ["reclaim"] => reclaim(wallet, &dir).await,
        _ => bail!("usage: judge-kit <create <count> <zat> [--names names.txt] [--base <url>] | status | reclaim>"),
    }
}

/// The web wallet's address: the mint URL without /mint.
fn default_base(mint_url: &str) -> Result<String> {
    mint_url
        .trim_end_matches('/')
        .strip_suffix("/mint")
        .filter(|b| b.starts_with("https://"))
        .map(str::to_owned)
        .ok_or_else(|| anyhow!("can't tell the web wallet's address from the mint URL {mint_url}; pass --base https://<host>"))
}

// ---- the kit file ----

fn kit_path(dir: &Path) -> PathBuf {
    dir.join("kit.json")
}

fn load(dir: &Path) -> Result<Vec<Value>> {
    match fs::read_to_string(kit_path(dir)) {
        Ok(s) => Ok(serde_json::from_str::<Value>(&s)?["judges"].as_array().cloned().unwrap_or_default()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(vec![]),
        Err(e) => Err(e.into()),
    }
}

fn save(dir: &Path, judges: &[Value]) -> Result<()> {
    write_private(&kit_path(dir), serde_json::to_string_pretty(&json!({ "judges": judges }))?.as_bytes())?;
    let mut csv = String::from("name,link,amount,created\n");
    for j in judges {
        let row = [j["name"].as_str().unwrap_or(""), j["link"].as_str().unwrap_or(""), &j["amount"].to_string(), &iso(j["created"].as_u64().unwrap_or(0))];
        csv.push_str(&row.iter().map(|c| csv_cell(c)).collect::<Vec<_>>().join(","));
        csv.push('\n');
    }
    write_private(&dir.join("kit.csv"), csv.as_bytes())
}

/// A private directory (700) for the kit.
fn private_dir(dir: &Path) -> Result<()> {
    let mut b = fs::DirBuilder::new();
    #[cfg(unix)]
    std::os::unix::fs::DirBuilderExt::mode(&mut b, 0o700);
    b.recursive(true).create(dir).with_context(|| format!("cannot create {}", dir.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(dir, fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}

/// Writes a file only this user can read (600), replacing it atomically.
fn write_private(path: &Path, bytes: &[u8]) -> Result<()> {
    let tmp = path.with_extension("tmp");
    let mut o = fs::OpenOptions::new();
    o.write(true).create(true).truncate(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut o, 0o600);
    let mut f = o.open(&tmp).with_context(|| format!("cannot write {}", tmp.display()))?;
    f.write_all(bytes)?;
    f.sync_all()?;
    fs::rename(&tmp, path)?;
    Ok(())
}

// ---- create, status, reclaim ----

async fn create(wallet: &Wallet, dir: &Path, base: &str, count: usize, zat: u64, names: &[String]) -> Result<()> {
    let need = zat.checked_mul(count as u64).context("too much")?;
    let balance = u64::from(wallet.total_balance().await?);
    if balance < need {
        bail!("not enough ecash for the kit: it needs {need} zat ({count} x {zat}), this wallet has {balance} zat");
    }
    private_dir(dir)?;
    let mut judges = load(dir)?;
    let first = judges.iter().filter_map(|j| j["n"].as_u64()).max().unwrap_or(0) + 1;
    for i in 0..count {
        let n = first + i as u64;
        let name = names.get(i).cloned().unwrap_or_else(|| format!("Judge {n}"));
        // compact (no DLEQ proofs): the shortest link and QR code; the claim is online anyway
        let (token, operation) = tokens::send_tracked(wallet, zat, None, true).await?;
        let link = format!("{base}/#/claim/{token}");
        let created = now();
        let stem = format!("judge-{n:02}-{}", slug(&name));
        // saved first: the token is in the kit (and can be reclaimed) even if a file below fails
        judges.push(json!({ "n": n, "name": name, "amount": zat, "created": created, "link": link, "token": token, "operation": operation, "files": stem }));
        save(dir, &judges)?;
        let qr = qrcode::QrCode::with_error_correction_level(link.as_bytes(), qrcode::EcLevel::M).context("the link is too long for a QR code")?;
        write_private(&dir.join(format!("{stem}.txt")), format!("{link}\n").as_bytes())?;
        write_private(&dir.join(format!("{stem}.png")), &qr_png(&qr, 8))?;
        write_private(&dir.join(format!("{stem}.pdf")), &judge_pdf(&name, zat, &link, &qr, created))?;
        println!("{stem}: {zat} zat for {name}");
    }
    println!(
        "{count} links, {need} zat, in {} (private: whoever has a link can claim it). Balance now {} zat.",
        dir.display(),
        u64::from(wallet.total_balance().await?)
    );
    Ok(())
}

/// What the mint says about a link's proofs (NUT-07).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LinkState {
    Unclaimed,
    /// Being redeemed right now.
    Claiming,
    Claimed,
    /// Taken back with `judge-kit reclaim`.
    Reclaimed,
}

pub fn classify(states: &[ProofState], reclaimed: bool) -> LinkState {
    if !states.is_empty() && states.iter().all(|s| *s == ProofState::Spent) {
        if reclaimed { LinkState::Reclaimed } else { LinkState::Claimed }
    } else if states.iter().any(|s| *s == ProofState::Pending || *s == ProofState::Spent) {
        LinkState::Claiming
    } else {
        LinkState::Unclaimed
    }
}

async fn states(wallet: &Wallet, judges: &[Value]) -> Result<Vec<LinkState>> {
    let infos = tokens::cached_keyset_infos(wallet).await?;
    let mut out = vec![];
    for j in judges {
        let token = Token::from_str(j["token"].as_str().unwrap_or("")).map_err(|e| anyhow!("kit.json: a bad token: {e}"))?;
        let proofs = token.proofs(&infos)?;
        let st = wallet.check_proofs_spent(proofs).await?;
        out.push(classify(&st.iter().map(|s| s.state).collect::<Vec<_>>(), j["reclaimed"].as_bool().unwrap_or(false)));
    }
    Ok(out)
}

async fn status(wallet: &Wallet, dir: &Path) -> Result<()> {
    let judges = load(dir)?;
    if judges.is_empty() {
        println!("no judge kit in {}", dir.display());
        return Ok(());
    }
    let st = states(wallet, &judges).await?;
    for (j, s) in judges.iter().zip(&st) {
        println!("{:<28} {:>7} zat  {}", format!("{} ({})", j["name"].as_str().unwrap_or("?"), j["files"].as_str().unwrap_or("")), j["amount"], label(*s));
    }
    let n = |want: LinkState| st.iter().filter(|s| **s == want).count();
    println!(
        "{} claimed, {} unclaimed, {} being claimed, {} reclaimed (of {})",
        n(LinkState::Claimed),
        n(LinkState::Unclaimed),
        n(LinkState::Claiming),
        n(LinkState::Reclaimed),
        judges.len()
    );
    Ok(())
}

fn label(s: LinkState) -> &'static str {
    match s {
        LinkState::Unclaimed => "unclaimed",
        LinkState::Claiming => "being claimed",
        LinkState::Claimed => "claimed",
        LinkState::Reclaimed => "reclaimed",
    }
}

async fn reclaim(wallet: &Wallet, dir: &Path) -> Result<()> {
    let mut judges = load(dir)?;
    let st = states(wallet, &judges).await?;
    let (mut count, mut total) = (0, 0u64);
    for (i, s) in st.into_iter().enumerate() {
        if s != LinkState::Unclaimed {
            continue;
        }
        let name = judges[i]["name"].as_str().unwrap_or("?").to_owned();
        let op = judges[i]["operation"].as_str().unwrap_or("").to_owned();
        match tokens::reclaim(wallet, &op).await {
            Ok(amount) => {
                judges[i]["reclaimed"] = json!(true);
                judges[i]["reclaimed_at"] = json!(now());
                count += 1;
                total += amount;
                println!("{name}: took back {amount} zat");
                save(dir, &judges)?;
            }
            // claimed in the meantime, for instance
            Err(e) => println!("{name}: not taken back: {e:#}"),
        }
    }
    println!("took back {count} unclaimed links, {total} zat; balance {} zat", u64::from(wallet.total_balance().await?));
    Ok(())
}

// ---- small helpers ----

fn now() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

/// Unix seconds as "2026-10-27T14:05:00Z".
pub fn iso(t: u64) -> String {
    let (days, secs) = ((t / 86_400) as i64, t % 86_400);
    // days since 1970-01-01 to a civil date (Howard Hinnant's algorithm)
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!("{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}Z", secs / 3600, secs % 3600 / 60, secs % 60)
}

/// "Ana Costa" -> "ana-costa" (ASCII letters and digits, at most 30).
pub fn slug(name: &str) -> String {
    let mut s = String::new();
    for c in name.chars() {
        if c.is_ascii_alphanumeric() {
            s.push(c.to_ascii_lowercase());
        } else if !s.ends_with('-') && !s.is_empty() {
            s.push('-');
        }
    }
    let s: String = s.trim_end_matches('-').chars().take(30).collect();
    if s.is_empty() { "judge".into() } else { s.trim_end_matches('-').to_owned() }
}

/// A CSV cell: quoted if needed; a leading = + - @ is defused (no spreadsheet formulas).
pub fn csv_cell(v: &str) -> String {
    let v = if v.starts_with(['=', '+', '-', '@']) { format!("'{v}") } else { v.to_owned() };
    if v.contains([',', '"', '\n', '\r']) || v.starts_with('\'') { format!("\"{}\"", v.replace('"', "\"\"")) } else { v }
}

// ---- PNG: 1-bit greyscale, zlib with stored (uncompressed) deflate blocks ----

fn crc32(bytes: &[u8]) -> u32 {
    let mut c = !0u32;
    for &b in bytes {
        c ^= u32::from(b);
        for _ in 0..8 {
            c = if c & 1 != 0 { 0xEDB8_8320 ^ (c >> 1) } else { c >> 1 };
        }
    }
    !c
}

fn adler32(bytes: &[u8]) -> u32 {
    let (mut a, mut b) = (1u32, 0u32);
    for &x in bytes {
        a = (a + u32::from(x)) % 65_521;
        b = (b + a) % 65_521;
    }
    (b << 16) | a
}

fn zlib_stored(data: &[u8]) -> Vec<u8> {
    let mut out = vec![0x78, 0x01];
    let mut chunks = data.chunks(65_535).peekable();
    if chunks.peek().is_none() {
        out.extend_from_slice(&[1, 0, 0, 0xff, 0xff]);
    }
    while let Some(c) = chunks.next() {
        out.push(u8::from(chunks.peek().is_none()));
        let len = c.len() as u16;
        out.extend_from_slice(&len.to_le_bytes());
        out.extend_from_slice(&(!len).to_le_bytes());
        out.extend_from_slice(c);
    }
    out.extend_from_slice(&adler32(data).to_be_bytes());
    out
}

fn chunk(out: &mut Vec<u8>, kind: &[u8; 4], data: &[u8]) {
    out.extend_from_slice(&(data.len() as u32).to_be_bytes());
    let start = out.len();
    out.extend_from_slice(kind);
    out.extend_from_slice(data);
    let crc = crc32(&out[start..]);
    out.extend_from_slice(&crc.to_be_bytes());
}

/// Is module (x, y) dark, counting a 4-module quiet zone around the code.
fn dark(qr: &qrcode::QrCode, x: i64, y: i64) -> bool {
    let w = qr.width() as i64;
    let (x, y) = (x - 4, y - 4);
    x >= 0 && y >= 0 && x < w && y < w && qr[(x as usize, y as usize)] == qrcode::Color::Dark
}

/// The QR code as a PNG, `scale` pixels per module, black on white with the quiet zone.
pub fn qr_png(qr: &qrcode::QrCode, scale: usize) -> Vec<u8> {
    let modules = qr.width() + 8;
    let side = modules * scale;
    let row_bytes = side.div_ceil(8);
    let mut raw = Vec::with_capacity((row_bytes + 1) * side);
    for py in 0..side {
        raw.push(0); // filter: none
        let mut row = vec![0u8; row_bytes];
        for px in 0..side {
            if !dark(qr, (px / scale) as i64, (py / scale) as i64) {
                row[px / 8] |= 0x80 >> (px % 8); // 1 = white
            }
        }
        raw.extend_from_slice(&row);
    }
    let mut out = b"\x89PNG\r\n\x1a\n".to_vec();
    let mut ihdr = vec![];
    ihdr.extend_from_slice(&(side as u32).to_be_bytes());
    ihdr.extend_from_slice(&(side as u32).to_be_bytes());
    ihdr.extend_from_slice(&[1, 0, 0, 0, 0]); // bit depth 1, greyscale, deflate, no filter, no interlace
    chunk(&mut out, b"IHDR", &ihdr);
    chunk(&mut out, b"IDAT", &zlib_stored(&raw));
    chunk(&mut out, b"IEND", &[]);
    out
}

// ---- PDF: one A4 page, built-in fonts, the QR code as vector squares ----

/// Text for a PDF string in the built-in fonts: ASCII only (others become "?"), escaped.
fn pdf_text(s: &str) -> String {
    s.chars()
        .map(|c| match c {
            '(' | ')' | '\\' => format!("\\{c}"),
            '\u{2019}' | '\u{2018}' => "'".into(),
            '\u{2014}' | '\u{2013}' => "-".into(),
            c if c.is_ascii() && !c.is_ascii_control() => c.to_string(),
            _ => "?".into(),
        })
        .collect()
}

fn group(n: u64) -> String {
    let s = n.to_string();
    let mut out = String::new();
    for (i, c) in s.chars().enumerate() {
        if i > 0 && (s.len() - i).is_multiple_of(3) {
            out.push(',');
        }
        out.push(c);
    }
    out
}

/// A printable page: the name, the QR code, the link, a warning and the tour steps.
pub fn judge_pdf(name: &str, zat: u64, link: &str, qr: &qrcode::QrCode, created: u64) -> Vec<u8> {
    let (w, h) = (595.28f64, 841.89f64);
    let mut c = String::new();
    let text = |c: &mut String, font: &str, size: f64, x: f64, y: f64, s: &str| c.push_str(&format!("BT /{font} {size} Tf {x:.2} {y:.2} Td ({}) Tj ET\n", pdf_text(s)));
    // gold band
    c.push_str(&format!("0.957 0.718 0.157 rg 0 {:.2} {w:.2} 10 re f\n0 0 0 rg\n", h - 10.0));
    text(&mut c, "F1", 10.0, 48.0, h - 48.0, "zec-ecash  |  judge kit");
    text(&mut c, "F2", 26.0, 48.0, h - 86.0, &format!("Welcome, {name}"));
    text(&mut c, "F1", 13.0, 48.0, h - 110.0, &format!("Scan to claim {} zats of ecash, then follow the tour.", group(zat)));
    // the QR code, quiet zone included
    let modules = qr.width() + 8;
    let size = 280.0;
    let m = size / modules as f64;
    let (qx, qy) = ((w - size) / 2.0, h - 140.0 - size);
    c.push_str(&format!("1 1 1 rg {qx:.2} {qy:.2} {size:.2} {size:.2} re f\n0 0 0 rg\n"));
    for y in 0..modules as i64 {
        for x in 0..modules as i64 {
            if dark(qr, x, y) {
                c.push_str(&format!("{:.3} {:.3} {m:.3} {m:.3} re\n", qx + x as f64 * m, qy + size - (y + 1) as f64 * m));
            }
        }
    }
    c.push_str("f\n");
    let mut y = qy - 24.0;
    text(&mut c, "F2", 10.0, 48.0, y, "Or open this link on your phone:");
    y -= 13.0;
    let per_line = 112; // Courier 7 pt: 4.2 pt per character in 499 pt
    for line in link.as_bytes().chunks(per_line) {
        text(&mut c, "F3", 7.0, 48.0, y, &String::from_utf8_lossy(line));
        y -= 9.0;
    }
    y -= 8.0;
    c.push_str(&format!("0.85 0.2 0.2 rg 48 {:.2} 3 14 re f 0 0 0 rg\n", y - 3.0));
    text(&mut c, "F2", 11.0, 58.0, y, "Anyone with this link can claim it. Don't share it.");
    y -= 30.0;
    text(&mut c, "F2", 12.0, 48.0, y, "The tour (also in the wallet: Settings > Open the judges' tour)");
    y -= 18.0;
    for (i, step) in TOUR.iter().enumerate() {
        text(&mut c, "F1", 10.0, 48.0, y, &format!("{}.  {step}", i + 1));
        y -= 15.0;
    }
    text(&mut c, "F1", 8.0, 48.0, 36.0, &format!("Created {}  |  single use  |  github.com/guni7/zec-ecash", iso(created)));

    let objects = [
        "<< /Type /Catalog /Pages 2 0 R >>".to_owned(),
        "<< /Type /Pages /Kids [3 0 R] /Count 1 >>".to_owned(),
        format!("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 {w} {h}] /Resources << /Font << /F1 4 0 R /F2 5 0 R /F3 6 0 R >> >> /Contents 7 0 R >>"),
        "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>".to_owned(),
        "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>".to_owned(),
        "<< /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding >>".to_owned(),
        format!("<< /Length {} >>\nstream\n{c}endstream", c.len()),
    ];
    let mut out = b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n".to_vec();
    let mut offsets = vec![];
    for (i, o) in objects.iter().enumerate() {
        offsets.push(out.len());
        out.extend_from_slice(format!("{} 0 obj\n{o}\nendobj\n", i + 1).as_bytes());
    }
    let xref = out.len();
    out.extend_from_slice(format!("xref\n0 {}\n0000000000 65535 f \n", objects.len() + 1).as_bytes());
    for off in offsets {
        out.extend_from_slice(format!("{off:010} 00000 n \n").as_bytes());
    }
    out.extend_from_slice(
        format!("trailer\n<< /Size {} /Root 1 0 R /Info << /Title (Judge kit: {}) /Producer (zec-ecash-cli) >> >>\nstartxref\n{xref}\n%%EOF\n", objects.len() + 1, pdf_text(name)).as_bytes(),
    );
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn checksums() {
        assert_eq!(crc32(b"IEND"), 0xAE42_6082);
        assert_eq!(adler32(b"Wikipedia"), 0x11E6_0398);
        // a stored zlib stream of 70,000 bytes: two blocks, the last marked final
        let z = zlib_stored(&[7u8; 70_000]);
        assert_eq!(&z[..3], &[0x78, 0x01, 0]);
        assert_eq!(z[2 + 5 + 65_535], 1);
    }

    #[test]
    fn png_is_well_formed() {
        let qr = qrcode::QrCode::with_error_correction_level(b"https://example.test/#/claim/cashuBabc", qrcode::EcLevel::M).unwrap();
        let png = qr_png(&qr, 4);
        assert_eq!(&png[..8], b"\x89PNG\r\n\x1a\n");
        let side = u32::from_be_bytes(png[16..20].try_into().unwrap()) as usize;
        assert_eq!(side, (qr.width() + 8) * 4);
        assert_eq!(&png[png.len() - 12..png.len() - 8], &0u32.to_be_bytes()[..], "IEND is empty");
        // every chunk's CRC checks out
        let mut i = 8;
        while i < png.len() {
            let len = u32::from_be_bytes(png[i..i + 4].try_into().unwrap()) as usize;
            let crc = u32::from_be_bytes(png[i + 8 + len..i + 12 + len].try_into().unwrap());
            assert_eq!(crc, crc32(&png[i + 4..i + 8 + len]));
            i += 12 + len;
        }
        assert_eq!(i, png.len());
    }

    #[test]
    fn pdf_xref_points_at_objects() {
        let qr = qrcode::QrCode::with_error_correction_level(b"x", qrcode::EcLevel::M).unwrap();
        let pdf = judge_pdf("Ana (lead) \\ José", 25_000, "https://h/#/claim/cashuBxyz", &qr, 1_793_100_000);
        // one char per byte, so string offsets are byte offsets (the header's binary marker is not UTF-8)
        let text: String = pdf.iter().map(|&b| if b.is_ascii() { b as char } else { '?' }).collect();
        assert!(pdf.starts_with(b"%PDF-1.4"));
        assert!(text.contains("(Welcome, Ana \\(lead\\) \\\\ Jos?)"), "escaped, ASCII only");
        assert!(text.contains("25,000 zats"));
        let start: usize = text.rsplit("startxref\n").next().unwrap().lines().next().unwrap().parse().unwrap();
        assert_eq!(&pdf[start..start + 4], b"xref");
        for (i, line) in text[start..].lines().skip(3).take(7).enumerate() {
            let off: usize = line[..10].parse().unwrap();
            assert!(text[off..].starts_with(&format!("{} 0 obj", i + 1)), "object {}", i + 1);
        }
        let len: usize = text.split("/Length ").nth(1).unwrap().split(' ').next().unwrap().parse().unwrap();
        let at = text.find("stream\n").unwrap() + "stream\n".len();
        assert_eq!(&text[at + len..at + len + 9], "endstream", "/Length is the stream's exact size");
    }

    #[test]
    fn helpers() {
        assert_eq!(iso(0), "1970-01-01T00:00:00Z");
        assert_eq!(iso(1_793_105_437), "2026-10-27T12:50:37Z");
        assert_eq!(iso(951_782_400), "2000-02-29T00:00:00Z");
        assert_eq!(slug("Ana Costa"), "ana-costa");
        assert_eq!(slug("  Dr. Zoë—Lee!! "), "dr-zo-lee");
        assert_eq!(slug("###"), "judge");
        assert_eq!(csv_cell("plain"), "plain");
        assert_eq!(csv_cell("a, \"b\""), "\"a, \"\"b\"\"\"");
        assert_eq!(csv_cell("=SUM(A1)"), "\"'=SUM(A1)\"");
        assert_eq!(default_base("https://zecmint.duckdns.org/mint").unwrap(), "https://zecmint.duckdns.org");
        assert!(default_base("http://127.0.0.1:8085").is_err());
    }

    #[test]
    fn link_states() {
        use ProofState::*;
        assert_eq!(classify(&[Unspent, Unspent], false), LinkState::Unclaimed);
        assert_eq!(classify(&[Spent, Spent], false), LinkState::Claimed);
        assert_eq!(classify(&[Spent, Spent], true), LinkState::Reclaimed);
        assert_eq!(classify(&[Pending, Unspent], false), LinkState::Claiming);
        assert_eq!(classify(&[Spent, Unspent], false), LinkState::Claiming);
        assert_eq!(classify(&[], false), LinkState::Unclaimed);
    }
}
