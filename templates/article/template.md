---
title: {{title|oneline}}
{{#subtitle}}
subtitle: {{subtitle|oneline}}
{{/subtitle}}
{{#date}}
date: {{date|oneline}}
{{/date}}
{{#author}}
author: {{author|oneline}}
{{/author}}
template: article
toc: false
---

{{#hero}}
```figure hero
{{src}} | {{caption|cells}} | {{credit|cells}}
```
{{/hero}}

{{#lead}}
```lead
{{{lead}}}
```
{{/lead}}

{{#blocks}}
{{#is_text}}
{{{text}}}

{{/is_text}}
{{#is_heading}}
## {{text|oneline}}

{{/is_heading}}
{{#is_figure}}
```figure{{#wide}} wide{{/wide}}
{{src}} | {{caption|cells}} | {{credit|cells}}
```

{{/is_figure}}
{{#is_gallery}}
```figure
{{#images}}
{{src}} | {{caption|cells}} | {{credit|cells}}
{{/images}}
```

{{/is_gallery}}
{{#is_chart}}
```chart {{kind|default:bar}} {{title|oneline}}
{{columns|csv}}
{{#rows}}
{{.|csv}}
{{/rows}}
```
{{#caption}}
<p class="chart-cap"><small>{{caption|oneline}}</small></p>
{{/caption}}

{{/is_chart}}
{{#is_quote}}
```quote
{{{text}}}
||
{{by|oneline}}
```

{{/is_quote}}
{{#is_callout}}
```callout {{tone|default:info}}
{{{text}}}
```

{{/is_callout}}
{{/blocks}}
{{#sources.0}}
## Sources

{{#sources}}
{{@n}}. {{#url}}[{{title|oneline}}]({{url}}){{/url}}{{^url}}{{title|oneline}}{{/url}}{{#publisher}}, {{publisher|oneline}}{{/publisher}}{{#date}} ({{date|oneline}}){{/date}}
{{/sources}}
{{/sources.0}}
