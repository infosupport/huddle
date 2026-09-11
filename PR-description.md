# WebP frontend asset migration

## Summary

- Adds WebP versions of ten frontend raster assets.
- Updates the six `main`-branch theme references for Aurora, Igloo, and Sunset to use WebP.
- Removes the six superseded PNG assets that are no longer referenced on `main`.
- Includes the Folder and IDE WebP variants for the matching assets currently used by the sandbox-branch UI; those usages are not present on `main` and are therefore not part of this PR.

## Asset-size comparison

All sizes are exact file sizes in bytes. Reduction is relative to the PNG source.

| Asset | PNG bytes | WebP bytes | Reduction |
| --- | ---: | ---: | ---: |
| `aurora-dark` | 652,857 | 62,536 | 90.4% |
| `aurora-light` | 614,715 | 50,284 | 91.8% |
| `folder-dark` | 203,928 | 58,800 | 71.2% |
| `folder` | 172,861 | 47,782 | 72.4% |
| `ide-jetbrains` | 506,397 | 7,786 | 98.5% |
| `ide-vscode` | 596,896 | 7,390 | 98.8% |
| `igloo-dark` | 271,249 | 25,968 | 90.4% |
| `igloo-light` | 263,705 | 23,196 | 91.2% |
| `sunset-dark` | 696,692 | 42,812 | 93.9% |
| `sunset-light` | 678,377 | 40,546 | 94.0% |

## Validation

No build or test run was requested for this asset-only change.
