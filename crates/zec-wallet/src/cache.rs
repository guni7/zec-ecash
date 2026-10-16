//! In-memory compact block cache for `zcash_client_backend::sync::run`.
//! Blocks only live for one sync; follows the `ExampleBlockCache` doc example in
//! zcash_client_backend/src/data_api/chain.rs, plus a real `with_blocks`, which scanning uses.
use std::{convert::Infallible, sync::Mutex};

use zcash_client_backend::{
    data_api::{
        chain::{BlockCache, BlockSource, error},
        scanning::ScanRange,
    },
    proto::compact_formats::CompactBlock,
};
use zcash_protocol::consensus::BlockHeight;

#[derive(Default)]
pub(crate) struct MemBlockCache {
    blocks: Mutex<Vec<CompactBlock>>,
}

fn height_of(block: &CompactBlock) -> BlockHeight {
    BlockHeight::from_u32(block.height as u32)
}

impl BlockSource for MemBlockCache {
    type Error = Infallible;

    fn with_blocks<F, WalletErrT>(
        &self,
        from_height: Option<BlockHeight>,
        limit: Option<usize>,
        mut with_block: F,
    ) -> Result<(), error::Error<WalletErrT, Self::Error>>
    where
        F: FnMut(CompactBlock) -> Result<(), error::Error<WalletErrT, Self::Error>>,
    {
        let mut blocks: Vec<CompactBlock> = self
            .blocks
            .lock()
            .unwrap()
            .iter()
            .filter(|b| from_height.is_none_or(|h| height_of(b) >= h))
            .cloned()
            .collect();
        blocks.sort_by_key(|b| b.height);
        for block in blocks.into_iter().take(limit.unwrap_or(usize::MAX)) {
            with_block(block)?;
        }
        Ok(())
    }
}

#[async_trait::async_trait]
impl BlockCache for MemBlockCache {
    fn get_tip_height(&self, range: Option<&ScanRange>) -> Result<Option<BlockHeight>, Self::Error> {
        Ok(self
            .blocks
            .lock()
            .unwrap()
            .iter()
            .map(height_of)
            .filter(|h| range.is_none_or(|r| r.block_range().contains(h)))
            .max())
    }

    async fn read(&self, range: &ScanRange) -> Result<Vec<CompactBlock>, Self::Error> {
        let mut blocks: Vec<CompactBlock> = self
            .blocks
            .lock()
            .unwrap()
            .iter()
            .filter(|b| range.block_range().contains(&height_of(b)))
            .cloned()
            .collect();
        blocks.sort_by_key(|b| b.height);
        Ok(blocks)
    }

    async fn insert(&self, mut compact_blocks: Vec<CompactBlock>) -> Result<(), Self::Error> {
        self.blocks.lock().unwrap().append(&mut compact_blocks);
        Ok(())
    }

    async fn delete(&self, range: ScanRange) -> Result<(), Self::Error> {
        self.blocks
            .lock()
            .unwrap()
            .retain(|b| !range.block_range().contains(&height_of(b)));
        Ok(())
    }
}
