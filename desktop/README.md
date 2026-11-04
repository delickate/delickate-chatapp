# PITBConnect Desktop

Electron desktop client for the Laravel chat API.

## Start

Start the Laravel backend first (default API address is
`http://127.0.0.1:8000/api`), then run these commands from this folder:

```powershell
npm install
npm start
```

Use **API connection settings** on the sign-in page to save a different
Laravel API URL (ending in `/api`) or Socket.IO server origin. Both settings
are saved locally for this desktop user. The default socket URL is
`http://127.0.0.1:3001`.

## Included

- Sign-up with name, international phone number, email, date of birth, and
  password.
- Sign-in with phone number and password.
- Bearer-token session and sign-out.
- Friend requests by phone, incoming request accept/reject, and accepted
  friends list.
- A friends-first sidebar with expandable search, add-friend, request, refresh,
  and update actions.
- One-to-one and group chats with paginated message history, send, unread
  counts, and seen/delivered receipt display.
- Create titled groups with accepted friends. Group membership is enforced by
  the API and unread counts are tracked separately for each member. Only the
  creator can remove other members; other participants can leave the group.
- Attach and download JPEG, PNG, GIF, WebP, PDF, and plain-text files (5 MiB
  maximum). The desktop checks the size before sending; Laravel performs the
  authoritative size, type, and content validation.
- Image attachments are cached per signed-in user in Electron's local
  application data folder on both sender and recipient devices. Cached images
  appear inline in chat, open in a full-size preview when clicked, and remain
  available after restarting the desktop app.
- Paste a copied screenshot or image into the chat message box to attach it;
  it appears in the attachment preview and sends with the message.
- One-to-one voice and video calls with incoming-call, mute, camera, and
  hang-up controls. Call audio uses a separate playback control for both voice
  and video calls. Electron asks permission for microphone and camera access;
  configure OS-level device permissions as well.

The desktop client connects to the authenticated Socket.IO service for online
presence and typing indicators. The service validates Sanctum tokens and
conversation membership with Laravel. Friend, conversation, and message lists
continue to refresh via the REST API every five seconds.
Calls use WebRTC peer-to-peer media and the Socket.IO service for authorized
signaling. A TURN relay is recommended for reliable connections across mobile
networks and restrictive firewalls.

## Versioning and releases

The desktop version is maintained in `package.json` and `package-lock.json`.
Use semantic versions (`MAJOR.MINOR.PATCH`); from this folder, run
`npm version patch --no-git-tag-version` for a bug-fix release, or use `minor`
or `major` when appropriate. Commit the version change, then tag and push the
matching version with a `v` prefix:

```powershell
npm version patch --no-git-tag-version
$version = node -p "require('./package.json').version"
git add package.json package-lock.json
git commit -m "Release desktop v$version"
git tag "v$version"
git push origin HEAD
git push origin "v$version"
```

This update sets the desktop version to `1.0.1`; after merging it, publish the
first updater-enabled installer by pushing tag `v1.0.1`.

The GitHub Actions release workflow builds the Windows installer and attaches
it to a GitHub Release. The desktop app checks the latest published release on
startup and provides a **Download** option when a newer version is available.
The Windows installer is downloaded directly and run by the user; updates are
not installed silently. Existing installations must first install a build
containing the update checker; subsequent releases can be discovered in-app.
For a local Windows build, use `npm run make`.

Builds use a process-specific temporary directory under
`desktop/out/.packager-tmp` so overlapping packaging runs cannot clear or reuse
each other's working files. A small compatibility patch copies the extracted
Electron files when Windows temporarily blocks Packager's directory rename.
The patch is reapplied after dependency installation and before desktop build
commands. If the copy is also blocked, Windows Security or another antivirus
may be holding files; allow the build to finish or add the project build
directory to its exclusions according to your organization's policy.
