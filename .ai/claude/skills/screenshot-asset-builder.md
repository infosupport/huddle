---
name: screenshot-asset-builder
description: transform uploaded ui screenshots into implementation-ready visual assets and code-ready asset manifests. use when the user provides light and/or dark theme screenshots and asks to recreate a page, extract images, identify non-functional visual assets, crop snippets, create light/dark asset variants, or ensure both themes share the same layout and asset placement.
---

# Screenshot Asset Builder

## Goal

Turn raw UI screenshots into a reliable implementation plan and asset set before writing UI code. Always start by identifying visual assets, then crop or recreate them, then build the UI around a single shared layout model.

## Core rule

Light and dark variants may differ in color, contrast, shadows, and asset appearance, but they must not differ in structure. Do not move, add, remove, resize, or reorder UI elements between themes unless the user explicitly asks for different UIs.

## Workflow

1. Ingest screenshots.
   - If one screenshot is provided, treat it as the canonical layout and create one asset set.
   - If two screenshots are provided, determine which is light and which is dark. If unclear, infer from background brightness.
   - Align screenshots by page bounds before comparing theme differences.

2. Determine candidate assets before implementation.
   - Search the whole page for visual images, illustrations, icons, avatars, logos, badges, decorative art, screenshots inside screenshots, and non-text graphical fragments.
   - Ignore regular UI text, labels, headings, button text, form copy, menu items, links, tab titles, and other functional words.
   - Allow logos or image captions/subscripts to remain part of an asset when they visually belong to the image, such as a logo wordmark or a word directly under an illustration.
   - Do not convert functional text into image assets. Functional text should become real UI text in the implementation.

3. Classify each candidate.
   - `asset`: image-like, decorative, brand, iconographic, avatar, logo, product screenshot, or illustration.
   - `functional_text`: labels, headings, navigation, form controls, button text, helper copy, table values, or any text needed for interaction or accessibility.
   - `background_or_surface`: page backgrounds, cards, panels, gradients, shadows, separators.
   - `uncertain`: anything that may be either image content or functional UI. Review manually before cropping.

4. Pair light and dark assets.
   - For every asset in the canonical layout, create matching coordinates for both themes.
   - Store variants with the same semantic id, for example `hero-illustration.light.png` and `hero-illustration.dark.png`.
   - If an asset is visible in one theme but missing or moved in the other, treat this as a layout mismatch. Prefer the canonical position and report the mismatch instead of silently creating different UI.

5. Normalize layout.
   - Build one global layout map from the canonical screenshot.
   - Use the same coordinates, dimensions, hierarchy, spacing, and ordering for light and dark.
   - Theme only colors, backgrounds, borders, shadows, and asset variant references.
   - Do not let theme comparison create separate DOM/layout structures.

6. Crop snippets.
   - Use exact bounding boxes from the canonical layout.
   - When both themes are available, crop the same bounding box from both images after alignment.
   - Add small padding only when it captures antialiasing, shadows, or natural image edges; apply the same padding to both themes.
   - Save a manifest with coordinates, role, theme variants, and notes.

7. Build implementation.
   - Create real text for functional text.
   - Use exported assets for illustrations, icons, logos, avatars, or embedded screenshots.
   - Use CSS variables or theme tokens for light/dark styling.
   - Reference `asset_id.light` and `asset_id.dark` through theme-aware code while keeping one component tree.

## Asset detection guidance

Be conservative. It is better to mark something `uncertain` than to crop functional words into an image. Common mistakes to avoid:

- Cropping a button, navigation item, tab, or form field as an image because it has a background.
- Cropping headings or marketing copy as part of a hero image when they are actually real text.
- Creating different asset dimensions for light and dark variants.
- Matching assets by visual color instead of by position and semantic role.
- Letting the dark theme use a different composition because contrast made detection harder.

## Required output structure

When asked to perform the workflow, produce these artifacts when possible:

```text
assets/
  manifest.json
  <asset-id>.light.png
  <asset-id>.dark.png
  <asset-id>.png
```

Use this manifest shape:

```json
{
  "source_screenshots": {
    "light": "light.png",
    "dark": "dark.png"
  },
  "canonical_theme": "light",
  "layout_policy": "single shared layout; theme may only change visual styling and asset variants",
  "assets": [
    {
      "id": "hero-illustration",
      "role": "asset",
      "bbox": {"x": 120, "y": 96, "width": 360, "height": 240},
      "variants": {
        "light": "hero-illustration.light.png",
        "dark": "hero-illustration.dark.png"
      },
      "contains_text": false,
      "functional_text": false,
      "notes": "illustration; same placement in both themes"
    }
  ],
  "layout_mismatches": []
}
```

## Optional helper script

Use `scripts/extract_assets.py` when the user provides screenshots and bounding boxes or when you want a repeatable crop pipeline.

Example:

```bash
python scripts/extract_assets.py --manifest manifest.json --out assets
```

The script expects each asset to include a `bbox` and source screenshot paths in `source_screenshots`. It crops the same bbox from each theme variant and writes a normalized manifest.

## Review checklist

Before finalizing, verify:

- All functional text remains implementable text, not image snippets.
- Each light/dark pair has the same bbox after alignment.
- Every theme variant uses the same asset id and semantic role.
- Layout differences are reported as mismatches, not encoded as separate UIs.
- Assets are named semantically, not by visual order alone.
