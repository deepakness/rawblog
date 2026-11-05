# rawblog

An opinionated [Eleventy](https://www.11ty.dev/) v3 starter for a personal site with two kinds of writing, long-form **blog posts** and short **raw notes**. It's the setup behind [deepakness.com](https://deepakness.com), with the personal bits taken out.

## Features

- **Blog + raw notes**, each with its own index, feed, and layout, plus a combined home feed and an archive by year and month
- **Tags**, related "Keep reading" entries, and client-side fuzzy **search** (Fuse.js, no server)
- **Open Graph images** generated for every post, note, and page (Satori)
- **Image pipeline** that resizes co-located images, converts them to WebP, and adds `<picture>` tags with width and height
- **Video pipeline** that turns an `.mp4` or `.mov` next to a post into an optimized MP4 with a poster frame, played with Plyr
- Optional **Cloudflare R2** sync to serve media from a separate asset domain
- **Atom feeds** (blog, notes, everything) with a styled XSL view, plus sitemap, robots.txt, and JSON-LD
- **Light, paper, and dark** themes, system fonts, very little JavaScript
- **Stats page** and footer counts (words, posts, notes, optional GitHub contributions)
- Bookmarks, books, projects, blogroll (with OPML), now, changelog, and colophon pages
- Drafts (`draft: true`) that render at their URL in `pnpm start`, but stay out of lists, feeds, and production builds
- Optional integrations for Umami analytics, Mastodon comment links, and CogSend social announcements
- An `AGENTS.md` with writing rules, so AI coding agents can draft posts and notes in your style

## Quick start

Requires Node.js 22+ and [pnpm](https://pnpm.io/) 11+.

Click **Use this template** on GitHub to create your own repo, then clone it. Or start from a plain copy.

```bash
git clone https://github.com/deepakness/rawblog.git my-site
cd my-site
rm -rf .git && git init   # skip if you used the template
pnpm install
pnpm site:setup   # name, URL, timezone, socials → site.config.js
pnpm start        # http://localhost:8080
```

Then make it yours.

1. Replace `public/img/avatar.png`, `public/img/avatar.webp`, and `public/favicon.ico`. The avatar is also used in the header, feeds, and OG images.
2. Edit `content/index.njk`, `content/about.njk`, and `content/now.njk`.
3. Edit or empty the data files in `_data/` (`projects.json`, `books.json`, `bookmarks.json`, `blogroll.json`, `changelog.json`, `gallery.json`) and the photos in `public/img/gallery/`.
4. Delete the sample posts in `content/blog/` and notes in `content/raw/`, keeping the `*.11tydata.js` files.
5. Run `pnpm ready` to generate OG images, then `pnpm check --strict` to catch leftover placeholders.

## Configuration

Your identity lives in `site.config.js`. Templates read it as `metadata`, and scripts import it directly. Empty values turn features off.

| Key | What it does |
| --- | --- |
| `title`, `url`, `description`, `language`, `locale` | Site basics for meta tags, feeds, sitemap, and JSON-LD |
| `timezone` | IANA zone for displayed dates, archive grouping, stats, and new post timestamps (default `UTC`) |
| `author` | Name, email (footer and "Comment via Email"), and avatar |
| `socials` | Footer icons and JSON-LD `sameAs`. `icon` is a [Phosphor](https://phosphoricons.com) icon name |
| `support` | Optional "support my work" link in the footer |
| `nav` | Header and footer navigation |
| `twitterHandle`, `googleSiteVerification` | Optional meta tags |
| `githubUsername` | GitHub contribution stats in the footer, `/about/`, and `/stats/` |
| `analytics` | Umami script URL and website ID |
| `mastodon` | `fediverse:creator` meta tag and `pnpm mastodon` |
| `cogsend` | Default platforms and the label before the title ("New post:") for social announcements |
| `affiliateNote` | Disclosure shown on entries with `affiliate: true` |
| `ogImage` | Footer text and photo for generated OG images |

Secrets go in `.env` (copy `.env.example`). All of them are optional.

| Variable | Used by |
| --- | --- |
| `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET` | `pnpm ready` uploads post media to R2, and skips the step when they're unset |
| `ASSET_ORIGIN` | Public URL of the R2 bucket. Post media URLs point here when it's set |
| `COGSEND_API_URL`, `COGSEND_API_KEY` | `blog:push` and `raw:push` announce new posts, and skip it when they're unset |

## Writing

```bash
pnpm blog my-post-slug   # content/blog/my-post-slug/index.md
pnpm raw my-note-slug    # content/raw/my-note-slug/index.md
```

The new file opens in `$EDITOR`, or in VS Code on macOS when `$EDITOR` is unset. These are the frontmatter fields.

```yaml
---
title: "Post title"
description: "One or two sentences for meta tags, feeds, and OG images."
date: 2026-11-05 09:30:00.000+00:00
updated: 2026-11-06       # optional, shown in the byline and feeds
image: /blog/my-post-slug/cover.png   # optional, replaces the generated OG image
affiliate: true           # optional, shows the affiliate disclosure
draft: true               # optional, previewable in `pnpm start`, never published
mastodon: "https://…"     # optional, filled by `pnpm mastodon`
tags:
- gardening
---
```

Put images and videos next to `index.md` and reference them relatively.

```md
![Alt text](./photo.jpg)

{% video "./clip.mp4" %}
```

A YouTube URL on its own line becomes a lightweight embed.

Preview with `pnpm start`. When the entry is done, `pnpm blog:push` or `pnpm raw:push` optimizes media, generates its OG image, commits, and pushes. Cloudflare Pages then deploys the site.

## Scripts

| Command | What it does |
| --- | --- |
| `pnpm start` | Dev server with live reload, drafts included |
| `pnpm run build` | Production build to `_site/` |
| `pnpm ready` | Optimize images, process videos, generate OG images, and sync to R2 if configured |
| `pnpm blog:push` / `pnpm raw:push` | Run `ready`, commit the entry, push, then announce it via CogSend if configured |
| `pnpm blog:update` / `pnpm raw:update` | Same, without the announcement |
| `pnpm bookmark <url> [--note "…"]` | Add a bookmark and fetch its title |
| `pnpm changelog "Title" "Description" [--link label=/path/]` | Add a changelog entry |
| `pnpm mastodon [--dry-run]` | Add `mastodon:` comment links to entries you've shared on Mastodon. `pnpm mastodon:push` commits them |
| `pnpm social` | Announce the latest committed entry via CogSend |
| `pnpm site:setup` | Interactive setup of `site.config.js` |
| `pnpm check [--strict]` | Warn about leftover placeholders, or fail on them with `--strict` |
| `pnpm format` | Format code with Prettier (Markdown and Nunjucks are left alone) |

Push flags work without `--`, as in `pnpm raw:push --dry-run` or `pnpm raw:push --no-social`.

Videos need `ffmpeg` installed (`brew install ffmpeg` or your package manager). Sites without videos don't need it.

## Media on Cloudflare R2 (optional)

By default, co-located images and videos are committed to git and served from your site. To serve them from R2 instead, follow these steps.

1. Create an R2 bucket and give it a public custom domain, or enable its r2.dev URL.
2. Create an R2 API token with read and write access to the bucket.
3. Fill in the `R2_*` variables and `ASSET_ORIGIN` in `.env`, and add `ASSET_ORIGIN` to your Cloudflare Pages environment variables.
4. Uncomment the media lines in `.gitignore` so images and videos stay out of git.

`pnpm ready` then uploads new or changed media, and the build points `/blog/…` and `/raw/…` media URLs at `ASSET_ORIGIN`.

## Deploy to Cloudflare Pages

1. Push the repo to GitHub.
2. In the Cloudflare dashboard, go to Workers & Pages → Create → Pages → Connect to Git, and pick the repo.
3. Set the build command to `pnpm run build` and the output directory to `_site`.
4. Add the environment variables `NODE_VERSION=22` and `PNPM_VERSION=11.24.0`, plus `ASSET_ORIGIN` if you use R2.
5. Add your domain under the project's Custom domains tab.

Cloudflare Pages picks up `public/_headers` and `public/_redirects` automatically.

The stats page and footer counts only change when the site rebuilds, so `.github/workflows/daily-rebuild.yml` triggers a rebuild once a day. Create a deploy hook (Pages project → Settings → Builds → Deploy hooks) and save its URL as the `CF_DEPLOY_HOOK` repository secret. Without the secret the workflow does nothing. GitHub pauses scheduled workflows after 60 days without repository activity, so re-enable it from the Actions tab if the site goes quiet that long.

`.github/workflows/ci.yml` runs a Prettier check, the build, and `pnpm check` on pushes to `main` and on pull requests.

## Project structure

```
site.config.js      Your identity, navigation, and integrations
content/blog/       Blog posts (slug/index.md + co-located media)
content/raw/        Raw notes (slug/index.md + co-located media)
content/            Pages, listing pages, feeds, sitemap
_includes/          Layouts and partials (Nunjucks)
_data/              Data files (books, projects, bookmarks, …) and computed data
_config/            Eleventy filters, timezone helper, related-posts scoring
public/             Static assets copied as-is (CSS in public/css/, JS, images, _headers, _redirects)
scripts/            Scaffolding, media pipeline, publishing, setup, check
```

When you add a top-level page in `content/`, add it to one of the lists in `_config/wordCountPages.js` so the word totals know whether to count it.

## Project statuses

Projects on `/projects/` use the `status` field in `_data/projects.json`. Add `"type": "mini"` for small projects.

| Status | Meaning |
| --- | --- |
| `active` | Actively maintained and updated |
| `stable` | Functional, not actively developed |
| `acquired` | Sold to someone else |
| `retired` | Served its purpose, no longer needed |
| `abandoned` | Accessible but unmaintained |
| `dead` | No longer accessible (strikethrough, no link) |

## Credits

Built by [DeepakNess](https://deepakness.com).

## License

[MIT](LICENSE)
