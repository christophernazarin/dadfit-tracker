# Dad Fit tracker

A kettlebell workout tracker. The phone page is one big button; the Google Sheet is the master record.

phone page (GitHub Pages) → Google Apps Script web app → Google Sheet "Dad Fit"

## Where everything lives

| Thing | Where |
|---|---|
| Your workout data (the master record) | The **Dad Fit** Google Sheet. Edit it directly any time |
| Phone page | `index.html` in this repo, published with GitHub Pages |
| Backend code | `apps-script/Code.gs`, pasted into the sheet's Apps Script (**Extensions → Apps Script**) |
| One-time migration and backfill | `apps-script/Migrate.gs` (also in Apps Script; safe to delete once you no longer need `backfill`) |
| Secret key | Apps Script **Project Settings → Script Properties → `SECRET_KEY`**, and typed once on each phone. It is never in this repo |
| Web app address | One line at the top of `index.html` (`API_URL`). It is not a secret |
| Tests | `dev/`. Run `node dev/test-backend.js` (needs Node and `npm install` inside `dev/`) |
| Original data, untouched | The `Old log (backup)` tab, and the `Dad Fit BACKUP` copy of the sheet |

## The tabs

- **Log**: one row per session. Formula columns (`session_no`, `day`, `week`, `on_schedule`) fill themselves.
- **Sets**: one row per exercise per session, copied from the plan when you tap. `total` is a formula.
- **Plan**: the current A, B, C. Exercises on the left, day / rounds on the right.
- **Plan history**: every version of the plan, with the date it first applied. Every Log row has a `plan_version`.
- **Sport**: rugby and badminton. Not counted as workouts.
- **Breaks**: planned breaks. Put the first and last date and a reason. Sessions in a break are not counted as missed.
- **Missed**: worked out by formula from the schedule. Do not edit.
- **Summary**: formulas only.
- **Settings**: the programme start date (decides week numbers).

## How to change the plan

1. Open the **Plan** tab. Change the amount, unit, per_side, or add a row for a new exercise. Rounds and day are in the small table on the right.
2. Do not touch the `version` column. Do not edit **Plan history**.
3. Log your next session as normal. The page notices the plan changed, saves the old one in Plan history, and gives the new one the next version (A6, B6, and so on), dated from that session.
4. Units are `reps` or `sec`. `per_side` is blank, `arm`, `leg` or `side` (it doubles the total).

## How to fix or add things in the sheet

- Wrong date or note on a session: edit the cell in **Log**. The formulas update.
- A session you did but never logged: edit the `BACKFILL` list at the bottom of the `Migrate` file in Apps Script, pick `backfill`, press Run.
- A planned break: add a row in **Breaks**.

## How to redeploy the Apps Script after changes

Only needed when you change `Code.gs` (not when you edit the sheet).

1. Paste the new `Code.gs` into Apps Script and press **Ctrl+S**.
2. Click **Deploy → Manage deployments**.
3. Click the **pencil** on your web app. Under **Version** choose **New version**. Click **Deploy**.
4. The address stays the same. Do **not** use "New deployment": that makes a different address and the page would stop working.

## Changing the secret key

1. In Apps Script **Project Settings → Script Properties**, change `SECRET_KEY`.
2. On each phone, the page will say the key was not accepted and ask for the new one.

## If something goes wrong

- Red "NOT confirmed saved" on the page: the sheet could not be reached. Tap the same button again. It will not log twice. Check the sheet to be sure.
- "That key was not accepted": retype the key.
- Page says nothing at all: check the web app address at the top of `index.html` is still the one under **Deploy → Manage deployments**.

## Doing a session on the page

1. Open the page. The big button says **Start Session A** (the one due next, worked out from what is already logged).
2. It shows the exercises from the **Plan** tab and a tick box for each round. Tap a round when you finish it. The rest timer at the bottom is manual: tap **Start rest** after each round. It buzzes at zero, and keeps the right time if the screen locks.
3. Tick the last round and the session **logs itself**, then shows the confirmation with Undo and a note box. Your ticks are saved on the phone as you go, so closing the page does not lose them.
4. If the sheet can't be reached at that moment, a red warning says so, nothing is logged, and your ticks are kept. Tap **Log Session A now** to try again. It will not log twice.
5. **Already done it?** Tap **Log Session A now** on the main screen to log without the guide.
6. The **A B C** chips at the top of the guide switch to another session.

Rest times (A 60 sec, B 60 sec, C 90 sec) are the `REST` line near the top of the script in `index.html`.