---
title: {{title|oneline}}
{{#subtitle}}
subtitle: {{subtitle|oneline}}
{{/subtitle}}
{{#status}}
status: {{status|oneline}}
{{/status}}
{{#date}}
date: {{date|oneline}}
{{/date}}
{{#author}}
author: {{author|oneline}}
{{/author}}
template: report
width: {{width}}
toc: {{toc}}
---

{{#summary}}
```lead
{{{summary}}}
```
{{/summary}}

{{#key_points.0}}
```callout info
**Key points**

{{#key_points}}
- {{{.}}}
{{/key_points}}
```
{{/key_points.0}}

{{#sections}}
## {{heading|oneline}}

{{{body}}}

{{#callout}}
```callout {{tone}}
{{{text}}}
```
{{/callout}}

{{/sections}}
{{#footnotes}}
[^{{id}}]: {{text|oneline}}
{{/footnotes}}
