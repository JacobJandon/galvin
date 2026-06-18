import { describe, it, expect } from "vitest";
import {
  buildChain,
  verifyChain,
  merkleRoot,
  merkleProof,
  verifyMerkleProof,
  sealBlock,
  GENESIS,
} from "../../registry/hashchain.js";

const recs = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    type: "spend",
    data: { i, cents: i * 10 },
    timestamp: new Date(1_700_000_000_000 + i * 1000).toISOString(),
  }));

describe("hash-chain — tamper-evident history", () => {
  it("builds + verifies a valid chain (links to genesis)", () => {
    const chain = buildChain(recs(5));
    const r = verifyChain(chain);
    expect(r.valid).toBe(true);
    expect(r.length).toBe(5);
    expect(r.head).toMatch(/^[a-f0-9]{64}$/);
    expect(chain[0].prevHash).toBe(GENESIS);
    expect(chain[1].prevHash).toBe(chain[0].hash);
  });

  it("catches a tampered past record — and says where", () => {
    const chain = buildChain(recs(5));
    (chain[2].data as { cents: number }).cents = 999_999; // alter history
    const r = verifyChain(chain);
    expect(r.valid).toBe(false);
    expect(r.brokenAt).toBe(2);
    expect(r.reason).toMatch(/tampered/);
  });

  it("catches a forged hash", () => {
    const chain = buildChain(recs(3));
    chain[1].hash = "deadbeef".repeat(8);
    const r = verifyChain(chain);
    expect(r.valid).toBe(false);
    expect(r.brokenAt).toBe(1);
  });

  it("the same records always produce the same head (deterministic)", () => {
    expect(verifyChain(buildChain(recs(4))).head).toBe(verifyChain(buildChain(recs(4))).head);
  });

  it("empty chain → genesis head", () => {
    expect(verifyChain([]).head).toBe(GENESIS);
  });
});

describe("Merkle blocks — batch confirmation + inclusion proofs", () => {
  it("seals a block whose root matches, and proves a record is in it", () => {
    const chain = buildChain(recs(6));
    const leaves = chain.map((e) => e.hash);
    const block = sealBlock(0, GENESIS, chain);
    expect(block.root).toBe(merkleRoot(leaves));
    expect(block.count).toBe(6);
    expect(block.blockHash).toMatch(/^[a-f0-9]{64}$/);

    const proof = merkleProof(leaves, 3);
    expect(verifyMerkleProof(leaves[3], 3, proof, block.root)).toBe(true);
    expect(verifyMerkleProof("0".repeat(64), 3, proof, block.root)).toBe(false); // forged leaf
  });

  it("inclusion proof works for every index, including odd counts", () => {
    const leaves = buildChain(recs(5)).map((e) => e.hash);
    const root = merkleRoot(leaves);
    for (let i = 0; i < leaves.length; i++) {
      expect(verifyMerkleProof(leaves[i], i, merkleProof(leaves, i), root)).toBe(true);
    }
  });

  it("empty batch → genesis root", () => {
    expect(merkleRoot([])).toBe(GENESIS);
  });
});
