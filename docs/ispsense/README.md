# Maintaining ISPSense Docs

These Markdown files are the source for the application's `/docs` site. They are bundled with the frontend and require no external documentation host or runtime credentials. They contain public product guidance only; do not add customer records, installation secrets, private network addresses, or environment-file contents.

Navigation, titles, descriptions, and status labels live in `frontend/src/docs/catalogue.ts`. Add an article there and a matching Markdown file here. Use `##` and `###` section headings (the page title is rendered separately) and `/docs/slug` internal links. Avoid raw HTML, duplicate headings, and tables; current Markdown rendering uses the existing safe basic renderer. Search indexes the same article content. Update feature-readiness guidance whenever an integration becomes qualified.

The repository's older root documentation and MkDocs configuration are retained as upstream engineering reference; this UI uses only this ISPSense folder. Design/protocol notes remain in `design/`. The nginx image copies this folder at build time, so rebuild nginx after edits. No remote documentation deployment is performed.
