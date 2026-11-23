# Fixtures

Synthetic pictures (smooth procedural noise, no photographed content) encoded
as HEIC with the platform's own encoder (`sips -s format heic -s formatOptions 40`
on macOS), so their structure is what a phone writes: an `hvc1` image, or a
`grid` of 512x512 `hvc1` tiles, HEVC Main Still Picture, 8-bit 4:2:0.

| File | Picture | Structure |
| --- | --- | --- |
| `grid.heic` | 1100x700 | grid of 3x2 tiles, `nclx` sRGB |
| `grid-48mp.heic` | 8064x6048 (a 48 MP phone photo's size) | grid of 9x6 tiles, `nclx` sRGB, encoded at quality 10 |
| `single.heic` | 96x64 | one `hvc1` image |
| `alpha.heic` | 300x200, transparent corners | one image and a 4:0:0 alpha plane |
| `p3.heic` | 300x200, transparent corners | as `alpha.heic`, tagged with a Display P3 ICC profile |

`grid-reference.json`, `grid-48mp-reference.json` and `p3-reference.json` hold the mean red, green and blue
of each block of a 5x5 (6x6, 4x4) grid over the platform decoder's rendering of the
same file converted to sRGB (`sips -m "sRGB Profile.icc" -s format png`), at
full size. The tests compare the decoder's output with them.
