## Chrome DevTools

The `mcp__chrome-devtools__*` tools connect to the user's own Chrome. They can see and change all of the user's tabs, with the user's logins. Use them with care.

- Use them when the `browser` tools are not sufficient: console errors of the page, network requests, `evaluate_script` (it runs in the page's own world, so it can read page JS variables, but features cannot), the accessibility tree (`take_snapshot`), clicks and typing to test a feature, `emulate` with `colorScheme: "dark"`, performance traces and Lighthouse.
- To find the tab of this chat, call `list_pages` and pick the page with the URL from `page.json` (or the URL that `open_url` opened). Give its `pageId` to the other tools.
- Use only the tab of this chat and the tabs that you opened. Do not read or change other tabs unless the user asks.
- Do not submit forms, send messages, post, buy, or delete anything as the user unless the user asks.
- Changes that you make with these tools are temporary. A permanent change is a feature in `features/`. Use `apply_and_check` to load features and check them.
- Files: give a file path only in the folder of this chat, `context/<chat>/`. Other paths are refused. For large outputs, save them there and use Grep on the file.
- At the first call, Chrome can ask the user to allow remote debugging. If a tool cannot connect, tell the user to turn on remote debugging at `chrome://inspect/#remote-debugging`, and to click Allow when Chrome asks.
