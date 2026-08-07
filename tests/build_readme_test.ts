import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { join } from "node:path";
import { encodeIco } from "icojs";
import sharp from "sharp";
import { addRefParameters, compileReadme } from "../scripts/build_readme.ts";

Deno.test("addRefParameters updates navigational links without touching images or code", () => {
  const input = [
    "[site](https://example.com/path?x=1#about)",
    "![image](https://example.com/image.png)",
    "[![badge](https://img.example.com/badge.svg)](https://example.com/target)",
    "[mail](mailto:test@example.com)",
    "<a href='//example.com/page'>HTML</a>",
    "<https://example.com/docs>",
    "[docs]: https://example.com/reference",
    "`[code](https://example.com/code)`",
    "```md\n[code](https://example.com/fenced)\n```",
  ].join("\n");

  const output = addRefParameters(input);

  assert.match(output, /https:\/\/example\.com\/path\?x=1&ref=github#about/);
  assert.match(output, /!\[image\]\(https:\/\/example\.com\/image\.png\)/);
  assert.match(
    output,
    /\[!\[badge\]\(https:\/\/img\.example\.com\/badge\.svg\)\]\(https:\/\/example\.com\/target\?ref=github\)/,
  );
  assert.match(output, /\[mail\]\(mailto:test@example\.com\)/);
  assert.match(output, /href='\/\/example\.com\/page\?ref=github'/);
  assert.match(output, /<https:\/\/example\.com\/docs\?ref=github>/);
  assert.match(output, /\[docs\]: https:\/\/example\.com\/reference\?ref=github/);
  assert.match(output, /`\[code\]\(https:\/\/example\.com\/code\)`/);
  assert.match(output, /\[code\]\(https:\/\/example\.com\/fenced\)/);
});

Deno.test("compileReadme downloads logos, bakes radii, and supports contrast backgrounds", async () => {
  const temporaryDirectory = await Deno.makeTempDir({ prefix: "readme-compiler-test-" });
  const templatePath = join(temporaryDirectory, "README.template.md");
  const outputPath = join(temporaryDirectory, "README.md");
  const assetDirectory = join(temporaryDirectory, "assets", "logos");
  const png = await sharp({
    create: { width: 80, height: 80, channels: 4, background: "#ff0000ff" },
  }).png().toBuffer();
  const transparentPng = await sharp({
    create: { width: 80, height: 80, channels: 4, background: "#00000000" },
  }).png().toBuffer();
  const ico = Buffer.from(await encodeIco([{ buffer: png }]));
  const controller = new AbortController();
  const server = Deno.serve(
    { hostname: "127.0.0.1", port: 0, signal: controller.signal, onListen: () => {} },
    (request) => {
      const pathname = new URL(request.url).pathname;
      const isIcon = pathname.endsWith(".ico");
      const body = pathname.endsWith("transparent.png") ? transparentPng : isIcon ? ico : png;
      return new Response(body, {
        headers: { "content-type": isIcon ? "image/x-icon" : "image/png" },
      });
    },
  );

  try {
    const baseUrl = `http://${server.addr.hostname}:${server.addr.port}`;
    await Deno.writeTextFile(
      templatePath,
      [
        "# Test",
        "",
        `<Logo src="${baseUrl}/soft.png" alt="Soft">`,
        `<Logo src="${baseUrl}/round.png" alt="Round" rounded>`,
        `<Logo src="${baseUrl}/transparent.png" alt="Contrast" rounded background="#ffffff">`,
        `<Logo src="${baseUrl}/favicon.ico" alt="ICO">`,
        "[Site](https://example.com/path)",
        "[Email](mailto:test@example.com)",
      ].join("\n"),
    );
    await Deno.mkdir(assetDirectory, { recursive: true });
    await Deno.writeFile(join(assetDirectory, "stale.png"), png);

    const first = await compileReadme({ templatePath, outputPath, assetDirectory });
    const generated = await Deno.readTextFile(outputPath);
    const assetNames = [];
    for await (const entry of Deno.readDir(assetDirectory)) {
      if (entry.isFile) {
        assetNames.push(entry.name);
      }
    }

    assert.equal(first.changed, true);
    assert.equal(first.assetCount, 4);
    assert.match(
      generated,
      /^<!-- Generated from README\.template\.md\. Do not edit README\.md directly;/,
    );
    assert.match(
      generated,
      /<img src="\.\/assets\/logos\/.+\.png" width="20" height="20" alt="Soft" \/>/,
    );
    assert.match(generated, /https:\/\/example\.com\/path\?ref=github/);
    assert.match(generated, /mailto:test@example\.com/);
    assert.equal(assetNames.includes("stale.png"), false);
    assert.equal(assetNames.length, 4);

    const softName = assetNames.find((name) => name.includes("-soft-soft-"));
    const roundName = assetNames.find((name) => name.includes("-round-round-"));
    const contrastName = assetNames.find((name) => name.includes("transparent-round-"));
    assert.ok(softName);
    assert.ok(roundName);
    assert.ok(contrastName);

    const soft = await sharp(join(assetDirectory, softName)).raw().toBuffer({
      resolveWithObject: true,
    });
    const round = await sharp(join(assetDirectory, roundName)).raw().toBuffer({
      resolveWithObject: true,
    });
    const contrast = await sharp(join(assetDirectory, contrastName)).raw().toBuffer({
      resolveWithObject: true,
    });
    assert.equal(soft.info.width, 64);
    assert.equal(soft.info.height, 64);
    assert.equal(round.info.width, 64);
    assert.equal(round.info.height, 64);
    const centerCoordinate = Math.floor(contrast.info.width / 2);
    const centerOffset = (centerCoordinate * contrast.info.width + centerCoordinate) *
      contrast.info.channels;
    assert.deepEqual(
      Array.from(contrast.data.subarray(centerOffset, centerOffset + contrast.info.channels)),
      [255, 255, 255, 255],
    );

    const sampleCoordinate = Math.floor(soft.info.width / 8);
    const pixelOffset = (sampleCoordinate * soft.info.width + sampleCoordinate) *
        soft.info.channels +
      3;
    assert.ok(soft.data[pixelOffset] > 200, "15% corner should retain the near-corner pixel");
    assert.ok(round.data[pixelOffset] < 50, "50% corner should remove the near-corner pixel");

    const second = await compileReadme({ templatePath, outputPath, assetDirectory });
    assert.equal(second.changed, false);
  } finally {
    controller.abort();
    await server.finished;
    await Deno.remove(temporaryDirectory, { recursive: true });
  }
});
