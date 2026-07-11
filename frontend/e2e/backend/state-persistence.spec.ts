import { expect, test } from "@playwright/test";

test("backend board survives reload with canonical refs and inline assets", async ({ page }) => {
  await page.goto("/");
  await page.waitForFunction(() => !!(window as unknown as { __editor?: unknown }).__editor);

  const suffix = crypto.randomUUID().slice(0, 8);
  const shapeId = `shape:persist-${suffix}`;
  const imageId = `shape:image-${suffix}`;
  const assetId = `asset:inline-${suffix}`;
  const dataUrl =
    "data:image/svg+xml;base64," +
    btoa(
      '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10" fill="red"/></svg>'
    );

  const ref = await page.evaluate(
    ({ shapeId, imageId, assetId, dataUrl }) => {
      const editor = (window as unknown as { __editor: any }).__editor;
      editor.createShape({
        id: shapeId,
        type: "idea-card",
        x: 100,
        y: 100,
        props: { title: "Backend reload proof", body: "ticket 233" }
      });
      editor.createAssets([
        {
          id: assetId,
          typeName: "asset",
          type: "image",
          props: { name: "inline.svg", src: dataUrl, w: 10, h: 10, mimeType: "image/svg+xml", isAnimated: false },
          meta: {}
        }
      ]);
      editor.createShape({ id: imageId, type: "image", x: 400, y: 100, props: { assetId, w: 100, h: 100 } });
      return editor.getShape(shapeId).meta.ref;
    },
    { shapeId, imageId, assetId, dataUrl }
  );
  expect(ref).toMatch(/^i\d+$/);

  // Board writes debounce for 500 ms; wait past the debounce/ack before reload.
  await page.waitForTimeout(900);
  await page.reload();
  await page.waitForFunction(() => !!(window as unknown as { __editor?: unknown }).__editor);

  const restored = await page.evaluate(
    ({ shapeId, imageId, assetId }) => {
      const editor = (window as unknown as { __editor: any }).__editor;
      return {
        card: editor.getShape(shapeId),
        image: editor.getShape(imageId),
        asset: editor.getAsset(assetId)
      };
    },
    { shapeId, imageId, assetId }
  );
  expect(restored.card.meta.ref).toBe(ref);
  expect(restored.image.props.assetId).toBe(assetId);
  expect(restored.asset.props.src).toBe(dataUrl);
});
