# Hook library sources (REELS-1124)

The lines `GET /hook-library` serves are read from these public sources by `src/lib/reels/hook-sources.ts` and stored in `hook_library`. Both are MIT licensed.

| Source id | Where | License | What we keep | What we never keep |
|---|---|---|---|---|
| `viral-hooks-skill` | https://github.com/rediumvex/viral-hooks-skill (`hooks-database.md`; adapted from https://github.com/jakeolschewski/social-media-hooks-database, MIT) | MIT | The 100 hook formulas with their [blanks], each with its category, its example and the platforms it is given for | Nothing else is in the file |
| `tiktok-hooks-finetune` | https://huggingface.co/datasets/benxh/tiktok-hooks-finetune (read through the datasets-server rows API, first 4,000 rows) | MIT | The on-screen hook text of English videos that beat their own account's usual views 10x or more, 3 to 14 words, the 300 most viewed; with views, likes, shares, the outlier multiplier and the main category | The creator handle, the video URL, the caption, the upload date |

Fonts: `fonts/Montserrat-ExtraBold.ttf` is Montserrat (https://github.com/JulietaUla/Montserrat, the upstream of google/fonts `ofl/montserrat`), SIL Open Font License 1.1, see `fonts/OFL.txt`.
