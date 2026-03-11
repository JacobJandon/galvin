/**
 * Minimal ethers v6 type stub.
 *
 * This file exists to give TypeScript a local type definition for "ethers"
 * instead of resolving to the actual ethers package types. The ethers v6
 * package's .d.ts files contain import references to src.ts/*.ts source
 * files which TypeScript 5.x then compiles, causing spurious type errors
 * (TS2322: Buffer<ArrayBufferLike>, TS7016: @types/ws) under NodeNext
 * module resolution.
 *
 * At runtime the real ethers package is used (via createRequire in
 * reputation/eas.ts and reputation/verifier.ts).  All symbols used by the
 * EAS SDK types are declared as "any" here so type-checking still passes
 * for our code.
 */

export type Signer = any;
export type Provider = any;
export type ContractRunner = any;
export type Overrides = Record<string, any>;
export type BigNumberish = bigint | number | string;
export type BytesLike = Uint8Array | string;
export type AddressLike = string;
export type TypedDataDomain = Record<string, any>;
export type TypedDataField = Record<string, any>;
export type EventFragment = any;
export type FunctionFragment = any;
export type Typed = any;
export type Interface = any;
export type Result = any;
export type Listener = any;
export type BaseContract = any;
export type ContractMethod = any;
export type ContractTransaction = any;
export type ContractTransactionResponse = any;
export type ContractDeployTransaction = any;
export type DeferredTopicFilter = any;
export type EventLog = any;
export type LogDescription = any;
export type TransactionRequest = any;
export type TransactionReceipt = any;
export type TransactionResponse = any;
export type Addressable = any;
export type ContractFactory = any;
export declare class Wallet {
  constructor(privateKey: string, provider?: any);
  readonly address: string;
  connect(provider: Provider): Wallet;
}
export declare class JsonRpcProvider {
  constructor(url: string, network?: any, options?: any);
}
export declare class BrowserProvider {
  constructor(provider: any, network?: any);
}
export declare const ethers: {
  Wallet: typeof Wallet;
  JsonRpcProvider: typeof JsonRpcProvider;
  BrowserProvider: typeof BrowserProvider;
  getAddress(address: string): string;
  hexlify(value: any): string;
  toUtf8Bytes(text: string): Uint8Array;
};
