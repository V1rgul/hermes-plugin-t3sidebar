# Provider marks, project icons and secondary-card dimming

## Causes and changes

- Project icons such as `home` and `tools` are native Codicon identifiers, not printable labels. Session cards and the new-session picker now share the public SDK `Codicon` renderer, preserve project colors and emoji, and use a Home glyph for synthetic Home. Folder choices preserve icon/color metadata from `projects.tree`.
- Many stored conversations have no explicit provider in their model configuration even though native usage accounting records their provider. The reader now falls back to distinct `session_model_usage.billing_provider` values for main-loop `task = ''`, across the card's native compression lineage. A sole concrete provider is accepted only without conflicting persisted configuration/billing evidence. Auxiliary vision/compression/title routes are excluded. Mixed, automatic or absent evidence remains unknown; model names and current profile defaults are never used to invent a historical provider.
- Provider recovery uses the existing read-only native connection and parameterized batches of at most 500 segment IDs. Missing legacy usage tables leave providers unknown instead of hiding conversations. Raw configuration, billing URLs and prompts remain excluded from card payloads.
- Working, Snoozed and Archived cards now share the same dimming, with full opacity restored on hover or focus. Ready attention and Pinned cards remain undimmed. Hover-action visibility and category scroll geometry are unchanged.

## Read-only metadata audit

The default profile was sampled with the plugin's native filters, without printing session IDs, titles, messages, raw configurations or credentials:

| Feed | Cards | Provider missing from configuration | Provider still unknown after recovery |
| --- | ---: | ---: | ---: |
| Regular, first page | 49 | 36 | 21 |
| Archived, first page | 500 | 218 | 7 |

All populated providers in this sample were already covered by the existing OpenAI/Codex or Anthropic logos. The remaining unknown entries have no trustworthy route evidence and must retain a neutral mark.

## Verification

The new icon/dimming, picker metadata and billing-recovery regressions were observed failing before their respective fixes. The final unchanged-source gate, `npm run test:all`, passed:

- 58 frontend/controller/integration tests.
- 59 backend tests, with ResourceWarning checking enabled.
- 74 Chromium checks, including matching dimmed opacity, hover restoration, picker glyph/label alignment and existing short-pane/Undo/error geometry.
- `git diff --check` passed.

The Codicon test adapter is explicitly synthetic; installed Desktop source confirms the public `Codicon({name, size})` contract. These checks do not claim native Windows/Electron rendering. Source fingerprints and the full gate log are in the task scratch directory; publication and installed-backend activation are separate operations.
