---
title: {{title|oneline}}
{{#subtitle}}
subtitle: {{subtitle|oneline}}
{{/subtitle}}
{{#date}}
date: {{date|oneline}}
{{/date}}
{{#status}}
status: {{status|oneline}}
{{/status}}
template: dashboard
---

```kpi
{{#kpis}}
{{label}} | {{value}} | {{note}} | {{verdict}}
{{/kpis}}
```

{{#alert}}
```callout {{tone}}
{{{text}}}
```
{{/alert}}

{{#charts.0}}
~~~~columns 2
{{#charts}}
```chart {{kind}} {{title|oneline}}
{{columns|csv}}
{{#rows}}
{{.|csv}}
{{/rows}}
```
{{^@last}}
||
{{/@last}}
{{/charts}}
~~~~
{{/charts.0}}

{{#progress.0}}
```progress
{{#progress}}
{{label}} | {{value}} | {{max}} | {{note}}
{{/progress}}
```
{{/progress.0}}

{{#table}}
{{#title}}
## {{title|oneline}}
{{/title}}

| {{columns|cells}} |
|{{columns|sep}}|
{{#rows}}
| {{.|cells}} |
{{/rows}}
{{/table}}

{{#notes}}
## Notes

{{{notes}}}
{{/notes}}
