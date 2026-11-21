# CodeGraph demo project

Open this folder in the Extension Development Host (launch configuration
**"Run CodeGraph on demo project"**) and run `CodeGraph: Open Graph`.

| Construct                             | Where                                               |
| ------------------------------------- | --------------------------------------------------- |
| Named import with alias               | `services/userService.ts` → `data/repository.ts`    |
| Default import                        | `app.ts` → `utils/date.ts`                          |
| Namespace import (`ns.fn()`)          | `app.ts` → `utils/logger.ts`                        |
| Static method of an imported class    | `app.ts` → `UserService.bootstrap`                  |
| `this.method()`                       | `UserService.register` → `UserService.notify`       |
| Arrow functions assigned to const     | `utils/date.ts`, `utils/validation.ts`              |
| TSX component                         | `components/UserCard.tsx`                           |
| CommonJS `require` / `module.exports` | `legacy/*.js`                                       |
| TS importing a CommonJS default       | `index.ts` → `legacy/server.js`                     |
| Re-exports (barrel)                   | `utils/index.ts` (file edge only, see limitations)  |
| Package import (ignored)              | `node:fs` in `app.ts`, `path` in `legacy/config.js` |

Calls through the barrel (`validateEmail` imported from `../utils`) are
intentionally left unresolved: following re-exports is a known POC limitation.
