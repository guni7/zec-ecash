//! Size-capped log files for the devnet's own processes (zec-processor, guardians, CLI).
//!
//! Logs go to `devnet/logs/<name>.log` and rotate at [`MAX_BYTES`]: `<name>.log` becomes
//! `<name>.log.1`, `.1` becomes `.2`, ... and the oldest beyond [`KEEP`] files is deleted. So a
//! runaway loop can cost at most `MAX_BYTES * (KEEP + 1)` of disk, never gigabytes.
//! (tracing-appender only rotates by time, which doesn't bound size within an hour.)
use std::{
    fs::{self, File, OpenOptions},
    io::{self, Write},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};

use tracing_subscriber::{EnvFilter, fmt::MakeWriter};

/// Rotate when the current file would exceed this.
pub const MAX_BYTES: u64 = 10 * 1024 * 1024;
/// Rotated files kept besides the current one.
pub const KEEP: usize = 5;

/// Logs to `<dir>/<name>.log` (rotating, see the crate docs) with `RUST_LOG` or `default_filter`.
/// Returns the log path.
pub fn init(dir: &Path, name: &str, default_filter: &str) -> anyhow::Result<PathBuf> {
    let writer = RotatingFile::open(dir, name, MAX_BYTES, KEEP)?;
    let path = writer.path();
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::try_from_default_env().unwrap_or_else(|_| default_filter.into()))
        .with_ansi(false)
        .with_writer(writer)
        .init();
    Ok(path)
}

struct State {
    path: PathBuf,
    file: File,
    size: u64,
    max: u64,
    keep: usize,
}

impl State {
    fn rotate(&mut self) -> io::Result<()> {
        let rotated = |n: usize| PathBuf::from(format!("{}.{n}", self.path.display()));
        let _ = fs::remove_file(rotated(self.keep));
        for n in (1..self.keep).rev() {
            let _ = fs::rename(rotated(n), rotated(n + 1));
        }
        fs::rename(&self.path, rotated(1))?;
        self.file = OpenOptions::new().create(true).append(true).open(&self.path)?;
        self.size = 0;
        Ok(())
    }
}

/// A log file that rotates by size. Cheap to clone; all clones share one file.
#[derive(Clone)]
pub struct RotatingFile(Arc<Mutex<State>>);

impl RotatingFile {
    pub fn open(dir: &Path, name: &str, max: u64, keep: usize) -> io::Result<Self> {
        fs::create_dir_all(dir)?;
        let path = dir.join(format!("{name}.log"));
        let file = OpenOptions::new().create(true).append(true).open(&path)?;
        let size = file.metadata()?.len();
        Ok(Self(Arc::new(Mutex::new(State { path, file, size, max, keep: keep.max(1) }))))
    }

    pub fn path(&self) -> PathBuf {
        self.0.lock().unwrap().path.clone()
    }
}

impl Write for RotatingFile {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        let mut s = self.0.lock().unwrap();
        if s.size > 0 && s.size + buf.len() as u64 > s.max {
            s.rotate()?;
        }
        let n = s.file.write(buf)?;
        s.size += n as u64;
        Ok(n)
    }

    fn flush(&mut self) -> io::Result<()> {
        self.0.lock().unwrap().file.flush()
    }
}

impl<'a> MakeWriter<'a> for RotatingFile {
    type Writer = RotatingFile;
    fn make_writer(&'a self) -> Self::Writer {
        self.clone()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rotation_bounds_total_size() {
        let dir = std::env::temp_dir().join(format!("devlog-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        let mut w = RotatingFile::open(&dir, "t", 1_000, 3).unwrap();
        let line = [b'x'; 99];
        for _ in 0..1_000 {
            w.write_all(&line).unwrap(); // ~99 KB written in total
        }
        let mut files: Vec<_> = fs::read_dir(&dir).unwrap().map(|e| e.unwrap().path()).collect();
        files.sort();
        let total: u64 = files.iter().map(|p| fs::metadata(p).unwrap().len()).sum();
        assert_eq!(files.len(), 4, "current + 3 rotated: {files:?}");
        assert!(total <= 4 * 1_000, "total {total} bytes");
        let _ = fs::remove_dir_all(&dir);
    }
}
