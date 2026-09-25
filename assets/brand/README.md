# Brand assets — PLACEHOLDERS, replace before go-live

| File | What it is |
|---|---|
| `hero-wellsfargo.jpg` | The client's own banner artwork, 3200×1200, used whole as the home hero. |
| `logo-white.png` | The WELLS FARGO wordmark, cropped out of that banner (700×110). |
| `logo.png` | The same crop. See below. |

`logo.png` and `logo-white.png` are the **same file**: a crop of white type on
the banner's dark background, which reads correctly both on the white header
and on a dark surface.

They are crops of a JPEG, not vector artwork, and there is no transparent
version and no red-on-white variant, because no official asset was supplied.
Get the real vector wordmark from Wells Fargo brand and replace both, then
split them into a dark-on-light `logo.png` and a light-on-dark
`logo-white.png` as the templates expect.

`hero-wellsfargo.jpg` is 1.5 MB of JPEG on the critical path of the home page.
Convert it to WebP before go-live (`scripts/optimize_images.py`, or
`cwebp -q 82`), which took the equivalent Deloitte banner from 722 KB to
25 KB. Point `banners[0].image_url` in `assets/site.json` at the `.webp`.
