/**
 * ONNX embedding model loader and inference.
 *
 * Uses onnxruntime-node to run CodeRankEmbed (quantized int8) locally.
 * Handles model download, tokenization, and batch embedding.
 */

import * as ort from "onnxruntime-node";
import { readFileSync, existsSync, mkdirSync, createWriteStream } from "node:fs";
import { join, dirname } from "node:path";
import { get as httpsGet } from "node:https";
import { homedir } from "node:os";

const MODEL_REPO = "jalipalo/CodeRankEmbed-onnx";
const MODEL_FILE = "onnx/model_quantized.onnx";
const TOKENIZER_FILE = "tokenizer.json";
const MODEL_URL = `https://huggingface.co/${MODEL_REPO}/resolve/main/${MODEL_FILE}`;
const TOKENIZER_URL = `https://huggingface.co/${MODEL_REPO}/resolve/main/${TOKENIZER_FILE}`;

const MODEL_DIR = join(homedir(), ".cache", "semantic-search", "models", "CodeRankEmbed-onnx-q8");
const MODEL_PATH = join(MODEL_DIR, "model_quantized.onnx");
const TOKENIZER_PATH = join(MODEL_DIR, "tokenizer.json");

const DIMENSIONS = 768;
const MAX_LENGTH = 128; // Signatures are ~50-70 tokens; model supports 8192 but padding wastes compute

/** Query prefix required by CodeRankEmbed */
const QUERY_PREFIX = "Represent this query for searching relevant code: ";

interface TokenizerConfig {
  model: {
    vocab: Record<string, number>;
  };
  added_tokens: Array<{ id: number; content: string }>;
}

// Simple WordPiece tokenizer — CodeRankEmbed uses BERT tokenizer
class SimpleTokenizer {
  private vocab: Map<string, number>;
  private clsId: number;
  private sepId: number;
  private padId: number;
  private unkId: number;

  constructor(tokenizerJson: TokenizerConfig) {
    this.vocab = new Map(Object.entries(tokenizerJson.model.vocab));

    // Find special token IDs
    this.clsId = this.vocab.get("[CLS]") ?? 101;
    this.sepId = this.vocab.get("[SEP]") ?? 102;
    this.padId = this.vocab.get("[PAD]") ?? 0;
    this.unkId = this.vocab.get("[UNK]") ?? 100;
  }

  encode(text: string, maxLength: number): { inputIds: number[]; attentionMask: number[] } {
    // Basic BERT-style tokenization:
    // 1. Lowercase
    // 2. Split on whitespace and punctuation
    // 3. WordPiece subword tokenization
    const lowered = text.toLowerCase();
    const words = this.basicTokenize(lowered);

    const tokens: number[] = [this.clsId];
    for (const word of words) {
      const subwords = this.wordPiece(word);
      for (const sw of subwords) {
        if (tokens.length >= maxLength - 1) break;
        tokens.push(sw);
      }
      if (tokens.length >= maxLength - 1) break;
    }
    tokens.push(this.sepId);

    // Pad to maxLength
    const inputIds = new Array(maxLength).fill(this.padId);
    const attentionMask = new Array(maxLength).fill(0);
    for (let i = 0; i < tokens.length; i++) {
      inputIds[i] = tokens[i];
      attentionMask[i] = 1;
    }

    return { inputIds, attentionMask };
  }

  private basicTokenize(text: string): string[] {
    // Split on whitespace, then separate punctuation
    const tokens: string[] = [];
    let current = "";

    for (const ch of text) {
      if (this.isPunctuation(ch) || this.isWhitespace(ch)) {
        if (current) tokens.push(current);
        if (this.isPunctuation(ch)) tokens.push(ch);
        current = "";
      } else {
        current += ch;
      }
    }
    if (current) tokens.push(current);
    return tokens;
  }

  private wordPiece(word: string): number[] {
    if (this.vocab.has(word)) {
      return [this.vocab.get(word)!];
    }

    const ids: number[] = [];
    let start = 0;
    while (start < word.length) {
      let end = word.length;
      let found = false;
      while (start < end) {
        const sub = start === 0 ? word.slice(start, end) : "##" + word.slice(start, end);
        if (this.vocab.has(sub)) {
          ids.push(this.vocab.get(sub)!);
          start = end;
          found = true;
          break;
        }
        end--;
      }
      if (!found) {
        ids.push(this.unkId);
        start++;
      }
    }
    return ids;
  }

  private isPunctuation(ch: string): boolean {
    const code = ch.charCodeAt(0);
    return (
      (code >= 33 && code <= 47) ||
      (code >= 58 && code <= 64) ||
      (code >= 91 && code <= 96) ||
      (code >= 123 && code <= 126)
    );
  }

  private isWhitespace(ch: string): boolean {
    return ch === " " || ch === "\t" || ch === "\n" || ch === "\r";
  }
}

export class Embedder {
  private session: ort.InferenceSession | null = null;
  private tokenizer: SimpleTokenizer | null = null;
  private ready = false;

  /** Check if the model is downloaded. */
  isModelDownloaded(): boolean {
    return existsSync(MODEL_PATH) && existsSync(TOKENIZER_PATH);
  }

  /** Download the model if not present. Calls onProgress with status messages. */
  async downloadModel(onProgress?: (msg: string) => void): Promise<void> {
    if (this.isModelDownloaded()) return;

    mkdirSync(MODEL_DIR, { recursive: true });

    if (!existsSync(TOKENIZER_PATH)) {
      onProgress?.("Downloading tokenizer...");
      await downloadFile(TOKENIZER_URL, TOKENIZER_PATH);
    }

    if (!existsSync(MODEL_PATH)) {
      onProgress?.("Downloading CodeRankEmbed model (~138MB)...");
      await downloadFile(MODEL_URL, MODEL_PATH, onProgress);
    }

    onProgress?.("Model download complete.");
  }

  /** Initialize the ONNX session and tokenizer. */
  async init(): Promise<void> {
    if (this.ready) return;

    if (!this.isModelDownloaded()) {
      throw new Error("Model not downloaded. Call downloadModel() first.");
    }

    // Load tokenizer
    const tokenizerData = JSON.parse(readFileSync(TOKENIZER_PATH, "utf-8"));
    this.tokenizer = new SimpleTokenizer(tokenizerData);

    // Load ONNX model
    const sessionOptions: ort.InferenceSession.SessionOptions = {
      executionProviders: ["cpu"],
      graphOptimizationLevel: "all",
    };

    this.session = await ort.InferenceSession.create(MODEL_PATH, sessionOptions);
    this.ready = true;
  }

  /**
   * Embed a batch of texts. Returns one Float32Array (768-dim) per input.
   * For document/code strings, pass as-is.
   * For search queries, the QUERY_PREFIX is added automatically.
   */
  async embed(texts: string[], isQuery = false, signal?: AbortSignal): Promise<Float32Array[]> {
    if (!this.session || !this.tokenizer) {
      throw new Error("Embedder not initialized. Call init() first.");
    }

    const results: Float32Array[] = [];

    // Process in batches to limit memory
    const BATCH_SIZE = 32;
    for (let i = 0; i < texts.length; i += BATCH_SIZE) {
      if (signal?.aborted) break;
      const batch = texts.slice(i, i + BATCH_SIZE);
      const batchResults = await this.embedBatch(batch, isQuery);
      results.push(...batchResults);
    }

    return results;
  }

  /** Embed a single query string (adds query prefix). */
  async embedQuery(query: string): Promise<Float32Array> {
    const results = await this.embed([query], true);
    return results[0];
  }

  private async embedBatch(texts: string[], isQuery: boolean): Promise<Float32Array[]> {
    const batchSize = texts.length;
    const allInputIds: number[] = [];
    const allAttentionMask: number[] = [];

    for (const text of texts) {
      const prefixed = isQuery ? QUERY_PREFIX + text : text;
      const { inputIds, attentionMask } = this.tokenizer!.encode(prefixed, MAX_LENGTH);
      allInputIds.push(...inputIds);
      allAttentionMask.push(...attentionMask);
    }

    // Create tensors
    const inputIdsTensor = new ort.Tensor(
      "int64",
      BigInt64Array.from(allInputIds.map(BigInt)),
      [batchSize, MAX_LENGTH],
    );
    const attentionMaskTensor = new ort.Tensor(
      "int64",
      BigInt64Array.from(allAttentionMask.map(BigInt)),
      [batchSize, MAX_LENGTH],
    );
    const tokenTypeIdsTensor = new ort.Tensor(
      "int64",
      new BigInt64Array(batchSize * MAX_LENGTH), // all zeros
      [batchSize, MAX_LENGTH],
    );

    // Run inference
    const feeds: Record<string, ort.Tensor> = {
      input_ids: inputIdsTensor,
      attention_mask: attentionMaskTensor,
      token_type_ids: tokenTypeIdsTensor,
    };

    const output = await this.session!.run(feeds);

    // Extract embeddings — model outputs token-level embeddings, we need to mean-pool
    // Output shape: [batch_size, seq_len, hidden_size]
    const outputName = this.session!.outputNames[0];
    const outputTensor = output[outputName];
    const outputData = outputTensor.data as Float32Array;
    const outputDims = outputTensor.dims as number[];

    const results: Float32Array[] = [];

    if (outputDims.length === 3) {
      // Token-level output: [batch, seq_len, hidden] — mean pool with attention mask
      const seqLen = outputDims[1];
      const hidden = outputDims[2];

      for (let b = 0; b < batchSize; b++) {
        const embedding = new Float32Array(hidden);
        let tokenCount = 0;

        for (let s = 0; s < seqLen; s++) {
          const maskIdx = b * MAX_LENGTH + s;
          if (allAttentionMask[maskIdx] === 0) continue;

          tokenCount++;
          const offset = b * seqLen * hidden + s * hidden;
          for (let h = 0; h < hidden; h++) {
            embedding[h] += outputData[offset + h];
          }
        }

        // Average
        if (tokenCount > 0) {
          for (let h = 0; h < hidden; h++) {
            embedding[h] /= tokenCount;
          }
        }

        // L2 normalize
        l2Normalize(embedding);
        results.push(embedding);
      }
    } else if (outputDims.length === 2) {
      // Already pooled: [batch, hidden]
      const hidden = outputDims[1];
      for (let b = 0; b < batchSize; b++) {
        const embedding = new Float32Array(hidden);
        const offset = b * hidden;
        for (let h = 0; h < hidden; h++) {
          embedding[h] = outputData[offset + h];
        }
        l2Normalize(embedding);
        results.push(embedding);
      }
    }

    return results;
  }

  /** Clean up the ONNX session. */
  async dispose(): Promise<void> {
    if (this.session) {
      // onnxruntime-node sessions don't have an explicit dispose in all versions
      this.session = null;
    }
    this.tokenizer = null;
    this.ready = false;
  }
}

function l2Normalize(vec: Float32Array): void {
  let norm = 0;
  for (let i = 0; i < vec.length; i++) {
    norm += vec[i] * vec[i];
  }
  norm = Math.sqrt(norm);
  if (norm > 0) {
    for (let i = 0; i < vec.length; i++) {
      vec[i] /= norm;
    }
  }
}

/** Download a file with redirect following. */
function downloadFile(
  url: string,
  dest: string,
  onProgress?: (msg: string) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const follow = (currentUrl: string, redirects = 0) => {
      if (redirects > 10) {
        reject(new Error("Too many redirects"));
        return;
      }

      httpsGet(currentUrl, (res) => {
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          // Handle relative redirects
          let nextUrl = res.headers.location;
          if (nextUrl.startsWith("/")) {
            const parsed = new URL(currentUrl);
            nextUrl = `${parsed.protocol}//${parsed.host}${nextUrl}`;
          }
          follow(nextUrl, redirects + 1);
          return;
        }

        if (res.statusCode !== 200) {
          reject(new Error(`Download failed: HTTP ${res.statusCode}`));
          return;
        }

        const totalBytes = parseInt(res.headers["content-length"] ?? "0", 10);
        let downloadedBytes = 0;
        let lastReport = 0;

        const file = createWriteStream(dest);
        res.on("data", (chunk: Buffer) => {
          downloadedBytes += chunk.length;
          if (totalBytes > 0 && onProgress) {
            const pct = Math.round((downloadedBytes / totalBytes) * 100);
            if (pct >= lastReport + 10) {
              lastReport = pct;
              const mb = (downloadedBytes / 1024 / 1024).toFixed(1);
              const totalMb = (totalBytes / 1024 / 1024).toFixed(1);
              onProgress(`Downloading... ${mb}MB / ${totalMb}MB (${pct}%)`);
            }
          }
        });
        res.pipe(file);
        file.on("finish", () => {
          file.close();
          resolve();
        });
        file.on("error", reject);
      }).on("error", reject);
    };

    follow(url);
  });
}
