//! The bytes of a PST file as the reader sees them: read at an offset from a
//! source the host owns (a file on disk, or bytes in memory), through a
//! meter that ends an operation once it has read its budget.

use std::{
    cell::Cell,
    io::{self, Read, Seek, SeekFrom},
    rc::Rc,
};

/// Where a PST file's bytes come from.
pub trait Source {
    /// The file's size in bytes.
    fn size(&self) -> u64;

    /// Reads into `buffer` from `offset`, returning how many bytes were read:
    /// fewer only at the end of the file.
    ///
    /// # Errors
    ///
    /// When the host cannot read, or refuses to (its deadline has passed);
    /// either stops the operation.
    fn read_at(&mut self, offset: u64, buffer: &mut [u8]) -> io::Result<usize>;
}

/// Bytes held in memory, such as a mailbox inside another file.
impl Source for Vec<u8> {
    fn size(&self) -> u64 {
        self.len() as u64
    }

    fn read_at(&mut self, offset: u64, buffer: &mut [u8]) -> io::Result<usize> {
        let start = usize::try_from(offset)
            .unwrap_or(usize::MAX)
            .min(self.len());
        let end = start.saturating_add(buffer.len()).min(self.len());
        let read = end - start;
        buffer[..read].copy_from_slice(&self[start..end]);
        Ok(read)
    }
}

/// Why an operation stopped reading.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Exhaustion {
    /// It read as many bytes as one operation may.
    Bytes,
    /// It asked the host for as many reads as one operation may.
    Reads,
    /// The host stopped it (a read that failed, or the host's deadline).
    Stopped,
}

/// What the current operation may still read. Shared between the reader
/// handed to the PST library and the code that starts each operation.
#[derive(Debug, Default)]
pub struct Meter {
    bytes: Cell<u64>,
    reads: Cell<u64>,
    max_bytes: Cell<u64>,
    max_reads: Cell<u64>,
    exhausted: Cell<Option<Exhaustion>>,
}

impl Meter {
    /// Starts an operation that may read `max_bytes` bytes in `max_reads`
    /// reads from the host.
    pub fn start(&self, max_bytes: u64, max_reads: u64) {
        self.bytes.set(0);
        self.reads.set(0);
        self.max_bytes.set(max_bytes);
        self.max_reads.set(max_reads);
        self.exhausted.set(None);
    }

    /// Why the current operation stopped reading, if it did.
    pub fn exhausted(&self) -> Option<Exhaustion> {
        self.exhausted.get()
    }

    /// Bytes the current operation has read.
    pub fn bytes(&self) -> u64 {
        self.bytes.get()
    }

    fn charge_bytes(&self, count: u64) -> io::Result<()> {
        let bytes = self.bytes.get().saturating_add(count);
        if bytes > self.max_bytes.get() {
            return Err(self.exhaust(Exhaustion::Bytes));
        }
        self.bytes.set(bytes);
        Ok(())
    }

    fn charge_read(&self) -> io::Result<()> {
        let reads = self.reads.get().saturating_add(1);
        if reads > self.max_reads.get() {
            return Err(self.exhaust(Exhaustion::Reads));
        }
        self.reads.set(reads);
        Ok(())
    }

    fn exhaust(&self, why: Exhaustion) -> io::Error {
        self.exhausted.set(Some(why));
        io::Error::other("the read budget is spent")
    }
}

/// Bytes read from the host at once, so neighbouring small reads (a page,
/// then the block next to it) cost one host read.
const READ_AHEAD_BYTES: usize = 16 * 1024;

/// A [`Source`] as the PST library reads it (`Read` + `Seek`), metered.
/// Every byte the library takes counts against the operation's budget,
/// whether or not it came from the read-ahead buffer.
pub struct Metered<S: Source> {
    source: S,
    meter: Rc<Meter>,
    size: u64,
    position: u64,
    buffer: Vec<u8>,
    buffer_offset: u64,
}

impl<S: Source> Metered<S> {
    pub fn new(source: S, meter: Rc<Meter>) -> Self {
        let size = source.size();
        Self {
            source,
            meter,
            size,
            position: 0,
            buffer: Vec::new(),
            buffer_offset: 0,
        }
    }

    fn buffered(&self) -> Option<&[u8]> {
        let start = self.position.checked_sub(self.buffer_offset)?;
        let start = usize::try_from(start).ok()?;
        (start < self.buffer.len()).then(|| &self.buffer[start..])
    }

    fn fill(&mut self, wanted: usize) -> io::Result<()> {
        self.meter.charge_read()?;
        let left = self.size.saturating_sub(self.position);
        let length = usize::try_from(left)
            .unwrap_or(usize::MAX)
            .min(wanted.max(READ_AHEAD_BYTES));
        // The cache holds bytes only once they are all read: a refill that
        // fails leaves it empty, never stale bytes under the old offset.
        self.buffer.clear();
        let mut refill = vec![0; length];
        let mut filled = 0;
        while filled < length {
            let read = self
                .source
                .read_at(self.position + filled as u64, &mut refill[filled..])
                .map_err(|_| self.meter.exhaust(Exhaustion::Stopped))?;
            if read == 0 {
                break;
            }
            filled += read;
        }
        refill.truncate(filled);
        self.buffer = refill;
        self.buffer_offset = self.position;
        Ok(())
    }
}

impl<S: Source> Read for Metered<S> {
    fn read(&mut self, out: &mut [u8]) -> io::Result<usize> {
        if out.is_empty() || self.position >= self.size {
            return Ok(0);
        }
        if self.buffered().is_none() {
            self.fill(out.len())?;
        }
        let Some(buffered) = self.buffered() else {
            return Ok(0);
        };
        let count = buffered.len().min(out.len());
        self.meter.charge_bytes(count as u64)?;
        out[..count].copy_from_slice(&buffered[..count]);
        self.position += count as u64;
        Ok(count)
    }
}

impl<S: Source> Seek for Metered<S> {
    fn seek(&mut self, to: SeekFrom) -> io::Result<u64> {
        let position = match to {
            SeekFrom::Start(offset) => Some(offset),
            SeekFrom::End(delta) => self.size.checked_add_signed(delta),
            SeekFrom::Current(delta) => self.position.checked_add_signed(delta),
        };
        let position = position.ok_or_else(|| {
            io::Error::new(io::ErrorKind::InvalidInput, "seek before the file's start")
        })?;
        self.position = position;
        Ok(position)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn metered(bytes: Vec<u8>, max_bytes: u64, max_reads: u64) -> (Metered<Vec<u8>>, Rc<Meter>) {
        let meter = Rc::new(Meter::default());
        meter.start(max_bytes, max_reads);
        (Metered::new(bytes, meter.clone()), meter)
    }

    #[test]
    fn reads_and_seeks_like_a_file() -> io::Result<()> {
        let bytes: Vec<u8> = (0..=255)
            .cycle()
            .take(40_000)
            .map(|b: u16| b as u8)
            .collect();
        let (mut reader, _) = metered(bytes.clone(), u64::MAX, u64::MAX);
        let mut out = [0_u8; 10];
        reader.seek(SeekFrom::Start(30_000))?;
        reader.read_exact(&mut out)?;
        assert_eq!(&out, &bytes[30_000..30_010]);
        reader.seek(SeekFrom::End(-4))?;
        let mut tail = Vec::new();
        reader.read_to_end(&mut tail)?;
        assert_eq!(tail, &bytes[39_996..]);
        reader.seek(SeekFrom::Start(5))?;
        reader.seek(SeekFrom::Current(2))?;
        reader.read_exact(&mut out)?;
        assert_eq!(&out, &bytes[7..17]);
        assert!(reader.seek(SeekFrom::Current(-100)).is_err());
        Ok(())
    }

    #[test]
    fn counts_every_byte_taken_even_from_the_buffer() {
        let (mut reader, meter) = metered(vec![7; 1000], 100, u64::MAX);
        let mut out = [0_u8; 60];
        assert!(reader.read_exact(&mut out).is_ok());
        assert_eq!(meter.bytes(), 60);
        assert!(reader.read_exact(&mut out).is_err());
        assert_eq!(meter.exhausted(), Some(Exhaustion::Bytes));
    }

    #[test]
    fn counts_reads_from_the_host() {
        let (mut reader, meter) = metered(vec![1; 100_000], u64::MAX, 2);
        let mut out = [0_u8; 8];
        assert!(reader.read_exact(&mut out).is_ok());
        assert!(reader.seek(SeekFrom::Start(50_000)).is_ok());
        assert!(reader.read_exact(&mut out).is_ok());
        assert!(reader.seek(SeekFrom::Start(90_000)).is_ok());
        assert!(reader.read_exact(&mut out).is_err());
        assert_eq!(meter.exhausted(), Some(Exhaustion::Reads));
    }

    /// A host that fails every read after the first.
    struct FailsAfterFirst {
        bytes: Vec<u8>,
        reads: usize,
    }

    impl Source for FailsAfterFirst {
        fn size(&self) -> u64 {
            self.bytes.len() as u64
        }

        fn read_at(&mut self, offset: u64, buffer: &mut [u8]) -> io::Result<usize> {
            self.reads += 1;
            if self.reads > 1 {
                return Err(io::Error::other("stopped"));
            }
            self.bytes.read_at(offset, buffer)
        }
    }

    #[test]
    fn a_failed_refill_leaves_no_stale_bytes() {
        let bytes: Vec<u8> = (0..100_000_u32).map(|index| (index % 251) as u8).collect();
        let meter = Rc::new(Meter::default());
        meter.start(u64::MAX, u64::MAX);
        let mut reader = Metered::new(
            FailsAfterFirst {
                bytes: bytes.clone(),
                reads: 0,
            },
            meter.clone(),
        );
        let mut out = [0_u8; 8];
        assert!(reader.read_exact(&mut out).is_ok());
        assert!(reader.seek(SeekFrom::Start(40_000)).is_ok());
        let mut large = vec![0_u8; 20_000];
        assert!(reader.read_exact(&mut large).is_err());
        // Bytes past the first read are never served from a stale cache.
        meter.start(u64::MAX, u64::MAX);
        assert!(reader.seek(SeekFrom::Start(17_000)).is_ok());
        assert!(reader.read_exact(&mut out).is_err());
    }

    #[test]
    fn a_new_operation_starts_with_a_full_budget() {
        let (mut reader, meter) = metered(vec![1; 100], 10, 10);
        let mut out = [0_u8; 20];
        assert!(reader.read_exact(&mut out).is_err());
        meter.start(100, 10);
        assert!(reader.seek(SeekFrom::Start(0)).is_ok());
        assert!(reader.read_exact(&mut out).is_ok());
        assert_eq!(meter.exhausted(), None);
    }
}
