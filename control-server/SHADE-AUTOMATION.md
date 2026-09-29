# Shade clip share-link automation

Swish Control receives finished Shade share links at:

`POST /api/shade/share-link`

For the production server this is appended to the normal Swish Control server URL.

## Shade automation

Create a Shade Automation for files landing in the room `CONTENT/CLIPS` folder:

1. Trigger when a new clip/file is available in that folder.
2. Create a published/quick share link for that asset using the workspace's normal link template.
3. Add an outgoing webhook action to Swish Control.
4. Send the webhook as JSON and include the generated share URL plus the asset filename or path.

Example payload:

```json
{
  "shareUrl": "<generated Shade share URL>",
  "fileName": "<asset filename>",
  "shadePath": "<asset path>"
}
```

Swish Control also accepts common nested/alternate names such as `share_url`, `published_url`,
`asset.name`, `asset.path`, `file.name`, and `file.path`.

Authenticate the webhook with either:

```
Authorization: Bearer <SHADE_WEBHOOK_KEY>
```

or:

```
x-swish-shade-key: <SHADE_WEBHOOK_KEY>
```

Set the same secret as `SHADE_WEBHOOK_KEY` in Railway.

## Delivery behavior

The room agent still copies clips to Shade exactly as before. Share-link generation is asynchronous and does not
block or change the file copy. Swish Control waits for the link for the configured grace period; if no link arrives,
Slack still receives the clip alert with `Link: Unavailable`.

The server health endpoint reports whether the callback secret is configured.
