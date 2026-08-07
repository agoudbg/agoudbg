import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import { basename, dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { decodeIco, isIco } from "icojs";
import sharp from "sharp";

const ROOT_DIRECTORY = fileURLToPath(new URL("../", import.meta.url));
const DEFAULT_TEMPLATE_PATH = join(ROOT_DIRECTORY, "README.template.md");
const DEFAULT_OUTPUT_PATH = join(ROOT_DIRECTORY, "README.md");
const DEFAULT_ASSET_DIRECTORY = join(ROOT_DIRECTORY, "assets", "logos");
const DEFAULT_REF = "github";
const MAX_DOWNLOAD_BYTES = 10 * 1024 * 1024;
const MAX_IMAGE_DIMENSION = 64;
const HEX_BACKGROUND_PATTERN = /^#[\da-f]{6}(?:[\da-f]{2})?$/i;
const BUILD_TARGETS = [
  { templatePath: DEFAULT_TEMPLATE_PATH, outputPath: DEFAULT_OUTPUT_PATH },
  {
    templatePath: join(ROOT_DIRECTORY, "README.zh-CN.template.md"),
    outputPath: join(ROOT_DIRECTORY, "README.zh-CN.md"),
  },
];

function generatedNotice(templatePath: string, outputPath: string): string {
  return `<!-- Generated from ${basename(templatePath)}. Do not edit ${
    basename(outputPath)
  } directly; run \`deno task build\`. -->`;
}

interface CompilerOptions {
  templatePath?: string;
  outputPath?: string;
  assetDirectory?: string;
  ref?: string;
  refresh?: boolean;
}

interface ParsedLogo {
  src: string;
  alt: string;
  background?: string;
  rounded: boolean;
}

interface LogoReplacement {
  end: number;
  index: number;
  replacement: string;
}

export interface CompileResult {
  assetCount: number;
  changed: boolean;
  outputPath: string;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function escapeHtmlAttribute(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function parseLogoAttributes(rawAttributes: string): ParsedLogo {
  const attributes = new Map<string, string | true>();
  const source = rawAttributes.trim().replace(/\/$/, "").trim();
  const attributePattern = /([A-Za-z][\w-]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/gy;
  let cursor = 0;

  while (cursor < source.length) {
    while (/\s/.test(source[cursor] ?? "")) {
      cursor += 1;
    }
    if (cursor >= source.length) {
      break;
    }

    attributePattern.lastIndex = cursor;
    const match = attributePattern.exec(source);
    if (!match) {
      throw new Error(`Invalid <Logo> attribute near: ${source.slice(cursor)}`);
    }

    const name = match[1].toLowerCase();
    if (!new Set(["src", "alt", "background", "rounded"]).has(name)) {
      throw new Error(`Unsupported <Logo> attribute: ${name}`);
    }
    if (attributes.has(name)) {
      throw new Error(`Duplicate <Logo> attribute: ${name}`);
    }

    attributes.set(name, match[2] ?? match[3] ?? match[4] ?? true);
    cursor = attributePattern.lastIndex;
  }

  const src = attributes.get("src");
  if (typeof src !== "string" || src.length === 0) {
    throw new Error("<Logo> requires a non-empty src attribute");
  }

  const url = new URL(src);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(`<Logo> only supports HTTP(S) sources: ${src}`);
  }

  const altAttribute = attributes.get("alt");
  if (altAttribute === true) {
    throw new Error("<Logo> alt must have a value");
  }

  const backgroundAttribute = attributes.get("background");
  if (backgroundAttribute === true) {
    throw new Error("<Logo> background must have a value");
  }
  if (typeof backgroundAttribute === "string" && !HEX_BACKGROUND_PATTERN.test(backgroundAttribute)) {
    throw new Error(
      `<Logo> background must be a 6- or 8-digit hex color: ${backgroundAttribute}`,
    );
  }

  return {
    src: url.href,
    alt: altAttribute ?? `${url.hostname} logo`,
    background: typeof backgroundAttribute === "string" ? backgroundAttribute : undefined,
    rounded: attributes.has("rounded"),
  };
}

function addRefToUrl(destination: string, ref: string): string {
  const protocolRelative = destination.startsWith("//");
  const url = new URL(protocolRelative ? `https:${destination}` : destination);
  url.searchParams.set("ref", ref);
  const result = url.href;
  return protocolRelative ? result.slice("https:".length) : result;
}

function transformNonCodeSegment(segment: string, ref: string): string {
  let transformed = segment.replace(
    /(\[!\[[^\]\r\n]*\]\(\s*<?(?:https?:\/\/|\/\/)[^)\s>]+>?\)\]\(\s*<?)((?:https?:\/\/|\/\/)[^)\s>]+)(>?\))/g,
    (_match, prefix: string, destination: string, suffix: string) =>
      `${prefix}${addRefToUrl(destination, ref)}${suffix}`,
  );

  transformed = transformed.replace(
    /(?<!!)\[(?!!)[^\]\r\n]+\]\(\s*<?(?:https?:\/\/|\/\/)[^)\s>]+>?/g,
    (match) => {
      const destinationStart = match.search(/(?:https?:\/\/|\/\/)/);
      const prefix = match.slice(0, destinationStart);
      const rawDestination = match.slice(destinationStart);
      const wrapped = rawDestination.endsWith(">");
      const destination = wrapped ? rawDestination.slice(0, -1) : rawDestination;
      return `${prefix}${addRefToUrl(destination, ref)}${wrapped ? ">" : ""}`;
    },
  );

  transformed = transformed.replace(
    /^(\s{0,3}\[[^\]]+\]:\s*<?)((?:https?:\/\/|\/\/)[^\s>]+)(>?)/gm,
    (_match, prefix: string, destination: string, suffix: string) =>
      `${prefix}${addRefToUrl(destination, ref)}${suffix}`,
  );

  transformed = transformed.replace(
    /(\bhref\s*=\s*)(["'])((?:https?:\/\/|\/\/)[^"']+)\2/gi,
    (_match, prefix: string, quote: string, destination: string) =>
      `${prefix}${quote}${addRefToUrl(destination, ref)}${quote}`,
  );

  transformed = transformed.replace(
    /<(https?:\/\/[^>\s]+)>/g,
    (_match, destination: string) => `<${addRefToUrl(destination, ref)}>`,
  );

  return transformed;
}

export function addRefParameters(markdown: string, ref = DEFAULT_REF): string {
  if (ref.length === 0) {
    throw new Error("ref must not be empty");
  }

  const codePattern = /(```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\r\n]*`)/g;
  let cursor = 0;
  let result = "";

  for (const match of markdown.matchAll(codePattern)) {
    const index = match.index ?? 0;
    result += transformNonCodeSegment(markdown.slice(cursor, index), ref);
    result += match[0];
    cursor = index + match[0].length;
  }

  return result + transformNonCodeSegment(markdown.slice(cursor), ref);
}

function assetFilename(logo: ParsedLogo): string {
  const url = new URL(logo.src);
  const pathPart = url.pathname.split("/").filter(Boolean).at(-1)?.replace(/\.[^.]+$/, "") ??
    "logo";
  const slug = `${url.hostname}-${pathPart}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 56) || "logo";
  const mode = logo.rounded ? "round" : "soft";
  const hashInput = logo.background
    ? `${logo.src}\0${mode}\0background=${logo.background}`
    : `${logo.src}\0${mode}`;
  const hash = createHash("sha256").update(hashInput).digest("hex").slice(0, 10);
  return `${slug}-${mode}-${hash}.png`;
}

async function download(url: string): Promise<Uint8Array> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);

  try {
    const response = await fetch(url, {
      headers: {
        Accept: "image/*",
        "User-Agent": "agoudbg-readme-compiler/1.0",
      },
      redirect: "follow",
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`Download failed with HTTP ${response.status}`);
    }

    const finalUrl = new URL(response.url);
    if (finalUrl.protocol !== "https:" && finalUrl.protocol !== "http:") {
      throw new Error(`Download redirected to an unsupported protocol: ${finalUrl.protocol}`);
    }

    const contentType = response.headers.get("content-type")?.split(";", 1)[0].trim();
    if (
      contentType && !contentType.startsWith("image/") && contentType !== "application/octet-stream"
    ) {
      throw new Error(`Expected an image but received ${contentType}`);
    }

    if (!response.body) {
      throw new Error("Download returned an empty response body");
    }

    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let totalBytes = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      totalBytes += value.byteLength;
      if (totalBytes > MAX_DOWNLOAD_BYTES) {
        await reader.cancel();
        throw new Error(`Image exceeds the ${MAX_DOWNLOAD_BYTES} byte limit`);
      }
      chunks.push(value);
    }

    if (totalBytes === 0) {
      throw new Error("Downloaded image is empty");
    }

    const bytes = new Uint8Array(totalBytes);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return bytes;
  } catch (error) {
    throw new Error(`Unable to download ${url}: ${errorMessage(error)}`, { cause: error });
  } finally {
    clearTimeout(timeout);
  }
}

async function decodeImage(bytes: Uint8Array): Promise<Buffer> {
  const input = Buffer.from(bytes);
  if (!isIco(input)) {
    return input;
  }

  const images = await decodeIco(input, "image/png");
  const largest = images.toSorted((left, right) => {
    const areaDifference = right.width * right.height - left.width * left.height;
    return areaDifference || right.bpp - left.bpp;
  })[0];
  if (!largest) {
    throw new Error("ICO file contains no images");
  }
  return Buffer.from(largest.buffer);
}

async function renderLogo(
  bytes: Uint8Array,
  rounded: boolean,
  background?: string,
): Promise<Uint8Array> {
  const input = await decodeImage(bytes);
  const normalized = await sharp(input, { animated: false })
    .rotate()
    .resize({
      width: MAX_IMAGE_DIMENSION,
      height: MAX_IMAGE_DIMENSION,
      fit: "inside",
      withoutEnlargement: true,
    })
    .ensureAlpha()
    .png()
    .toBuffer({ resolveWithObject: true });

  const { width, height } = normalized.info;
  const radius = Math.max(1, Math.round(Math.min(width, height) * (rounded ? 0.5 : 0.15)));
  const mask = Buffer.from(
    `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg"><rect width="${width}" height="${height}" rx="${radius}" ry="${radius}" fill="white"/></svg>`,
  );

  const image = sharp(normalized.data);
  if (background) {
    image.flatten({ background });
  }

  return await image
    .composite([{ input: mask, blend: "dest-in" }])
    .png({ compressionLevel: 9 })
    .toBuffer();
}

async function ensureLogoAsset(
  logo: ParsedLogo,
  assetDirectory: string,
  refresh: boolean,
): Promise<string> {
  const filename = assetFilename(logo);
  const outputPath = join(assetDirectory, filename);

  if (!refresh) {
    try {
      const info = await Deno.stat(outputPath);
      if (info.isFile) {
        return filename;
      }
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) {
        throw error;
      }
    }
  }

  const source = await download(logo.src);
  const rendered = await renderLogo(source, logo.rounded, logo.background);
  await Deno.writeFile(outputPath, rendered);
  return filename;
}

async function replaceLogoTags(
  markdown: string,
  outputPath: string,
  assetDirectory: string,
  refresh: boolean,
): Promise<{ markdown: string; filenames: Set<string> }> {
  const tagPattern = /<Logo\b([^<>]*?)(?:\/?)>(?:\s*<\/Logo>)?/g;
  const matches = [...markdown.matchAll(tagPattern)];
  const filenames = new Set<string>();

  await Deno.mkdir(assetDirectory, { recursive: true });

  const replacements: LogoReplacement[] = await Promise.all(
    matches.map(async (match) => {
      const logo = parseLogoAttributes(match[1]);
      const filename = await ensureLogoAsset(logo, assetDirectory, refresh);
      filenames.add(filename);
      const markdownPath = relative(dirname(outputPath), join(assetDirectory, filename)).replaceAll(
        "\\",
        "/",
      );
      const src = markdownPath.startsWith(".") ? markdownPath : `./${markdownPath}`;
      return {
        end: (match.index ?? 0) + match[0].length,
        index: match.index ?? 0,
        replacement: `<img src="${escapeHtmlAttribute(src)}" width="20" height="20" alt="${
          escapeHtmlAttribute(logo.alt)
        }" />`,
      };
    }),
  );

  let cursor = 0;
  let result = "";
  for (const replacement of replacements) {
    result += markdown.slice(cursor, replacement.index);
    result += replacement.replacement;
    cursor = replacement.end;
  }

  return { markdown: result + markdown.slice(cursor), filenames };
}

async function removeStaleAssets(assetDirectory: string, expected: Set<string>): Promise<void> {
  for await (const entry of Deno.readDir(assetDirectory)) {
    if (entry.isFile && entry.name.endsWith(".png") && !expected.has(entry.name)) {
      await Deno.remove(join(assetDirectory, entry.name));
    }
  }
}

async function writeIfChanged(path: string, content: string): Promise<boolean> {
  try {
    if (await Deno.readTextFile(path) === content) {
      return false;
    }
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) {
      throw error;
    }
  }

  await Deno.writeTextFile(path, content);
  return true;
}

export async function compileReadme(options: CompilerOptions = {}): Promise<CompileResult> {
  const templatePath = options.templatePath ?? DEFAULT_TEMPLATE_PATH;
  const outputPath = options.outputPath ?? DEFAULT_OUTPUT_PATH;
  const assetDirectory = options.assetDirectory ?? DEFAULT_ASSET_DIRECTORY;
  const template = await Deno.readTextFile(templatePath);
  const logos = await replaceLogoTags(
    template,
    outputPath,
    assetDirectory,
    options.refresh ?? false,
  );
  const linked = addRefParameters(logos.markdown, options.ref ?? DEFAULT_REF);
  const generated = `${generatedNotice(templatePath, outputPath)}\n\n${linked.trimEnd()}\n`;

  await removeStaleAssets(assetDirectory, logos.filenames);
  const changed = await writeIfChanged(outputPath, generated);
  return { assetCount: logos.filenames.size, changed, outputPath };
}

async function compileAll(refresh: boolean): Promise<void> {
  for (const target of BUILD_TARGETS) {
    const result = await compileReadme({ ...target, refresh });
    console.log(
      `${
        result.changed ? "Generated" : "Checked"
      } ${result.outputPath} with ${result.assetCount} logo assets.`,
    );
  }
}

async function watchReadme(refresh: boolean): Promise<void> {
  const templatePaths = BUILD_TARGETS.map((target) => target.templatePath);
  const watcher = Deno.watchFs(templatePaths);
  let timer: number | undefined;
  let building = false;
  let pending = false;

  const build = async (): Promise<void> => {
    if (building) {
      pending = true;
      return;
    }
    building = true;
    try {
      await compileAll(refresh);
    } catch (error) {
      console.error(`README build failed: ${errorMessage(error)}`);
    } finally {
      building = false;
      if (pending) {
        pending = false;
        await build();
      }
    }
  };

  await build();
  console.log(`Watching ${templatePaths.join(", ")}`);

  for await (const event of watcher) {
    if (event.kind !== "modify" && event.kind !== "create") {
      continue;
    }
    clearTimeout(timer);
    timer = setTimeout(() => void build(), 150);
  }
}

function parseArguments(args: string[]): { refresh: boolean; watch: boolean } {
  const unknown = args.filter((argument) => argument !== "--refresh" && argument !== "--watch");
  if (unknown.length > 0) {
    throw new Error(`Unknown argument${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}`);
  }
  return { refresh: args.includes("--refresh"), watch: args.includes("--watch") };
}

async function main(): Promise<void> {
  const arguments_ = parseArguments(Deno.args);
  if (arguments_.watch) {
    await watchReadme(arguments_.refresh);
    return;
  }

  await compileAll(arguments_.refresh);
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    console.error(`README build failed: ${errorMessage(error)}`);
    Deno.exit(1);
  }
}
