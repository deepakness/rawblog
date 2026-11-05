---
title: "Embedding videos in a post"
description: "How to add a self-hosted video or a YouTube embed to a post or note."
date: 2026-11-01 11:00:00.000+00:00
tags:
- til
---

Drop an `.mp4` next to the post's `index.md` and use the video shortcode. `pnpm ready` transcodes it and creates a `clip-poster.webp` poster frame.

```njk
{% raw %}{% video "./clip.mp4" %}{% endraw %}
```

For YouTube, paste the video URL on its own line. It renders as a lightweight embed that only loads the player on click.
