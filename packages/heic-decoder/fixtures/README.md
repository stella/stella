# Fixtures

Synthetic pictures (smooth procedural noise, no photographed content) encoded
as HEIC with the platform's own encoder (`sips -s format heic -s formatOptions 40`
on macOS), so their structure is what a phone writes: an `hvc1` image, or a
`grid` of 512x512 `hvc1` tiles, HEVC Main Still Picture, 8-bit 4:2:0.

| File | Picture | Structure |
| --- | --- | --- |
| `grid.heic` | 1100x700 | grid of 3x2 tiles, `nclx` sRGB |
| `single.heic` | 96x64 | one `hvc1` image |
| `alpha.heic` | 300x200, transparent corners | one image and a 4:0:0 alpha plane |
| `p3.heic` | 300x200, transparent corners | as `alpha.heic`, tagged with a Display P3 ICC profile |

`grid-reference.json` and `p3-reference.json` hold the mean red, green and blue
of each block of a 5x5 (4x4) grid over the platform decoder's rendering of the
same file converted to sRGB (`sips -m "sRGB Profile.icc" -s format png`), at
full size. The tests compare the decoder's output with them.
