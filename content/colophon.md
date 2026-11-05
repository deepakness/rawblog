---
title: "Colophon"
description: "How this website is built, and the principles behind it."
---

# {{ title }}

{{ description }}

## Principles

- **HTML first, light JavaScript**: Content and layout work without JS. A small global bundle handles theme preference, code-copy, and the search shortcut. Heavier scripts (search, bookmarks filter) only load on the pages that need them.
- **Fast and lightweight**: Every page aims for perfect Lighthouse scores.
- **Own the content**: Everything is Markdown files in a Git repo.

## Stack

- [Eleventy (11ty)](https://11ty.dev): Static site generator (v3). Templates are Nunjucks.
- [Cloudflare Pages](https://pages.cloudflare.com): Hosting. Push to deploy.
- [Markdown](https://en.wikipedia.org/wiki/Markdown): All content is written in Markdown with YAML frontmatter.

## Images and videos

- [Sharp](https://sharp.pixelplumbing.com): Resizes and converts images to WebP locally.
- [Satori](https://github.com/vercel/satori): Generates Open Graph images (1200x630) for every post and note.
- [FFmpeg](https://ffmpeg.org): Transcodes videos to optimized MP4s and extracts poster frames.
- [Plyr](https://plyr.io): Video player skin over the native element, vendored locally.
- [Cloudflare R2](https://developers.cloudflare.com/r2/) (optional): Hosts images and videos on a separate asset domain.

## Search

Client-side fuzzy search powered by [Fuse.js](https://www.fusejs.io/). The search index is generated at build time as a static JSON file.

## Feeds

Three Atom feeds are available: [blog posts](/feed/feed.xml), [raw notes](/feed/raw.xml), and a [combined archive](/feed/archive.xml). More on the [feeds page](/feed/).

## Typography

System fonts throughout, with the system monospace stack for code.

## Themes

Three reading themes: light, paper, and dark. Without a saved choice, the site follows the browser's light or dark preference.

For notable site changes, [see the changelog](/changelog/).
