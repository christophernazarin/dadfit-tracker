# Dad Fit tracker: setup

Stage 2 (backend). The phone page and publishing come in later stages, so this file only covers the Google Sheet and Apps Script for now.

How it fits together: **phone page (GitHub Pages) → Google Apps Script → your Google Sheet.** The sheet is the master record.

## Part 1. Back up, then migrate

1. Open your Dad Fit sheet in Google Sheets.
2. Click **File → Make a copy**. Name it `Dad Fit BACKUP`, click **Make a copy**. Close that tab and never edit it. This is your safety net.
3. Back in your real **Dad Fit** sheet, click **File → Settings**. Check **Time zone** is your own (for example Dublin or London). Click **Save settings** if you changed it. Dates and times logged from your phone use this time zone.
4. Click **Extensions → Apps Script**. A new tab opens with a file called `Code.gs`.
5. Click in the code, press **Ctrl+A**, then **Delete**. Open `apps-script\Code.gs` from this folder in Notepad, press **Ctrl+A**, **Ctrl+C**, go back to the Apps Script tab and press **Ctrl+V**. Press **Ctrl+S**.
6. Click the **+** next to "Files" (top left) → **Script**. Type `Migrate` as the name (not `Migrate.gs`). Delete anything in it, then paste in the whole of `apps-script\Migrate.gs` the same way. Press **Ctrl+S**.
7. In the toolbar, click the function dropdown (it may say `myFunction` or `Code`) and choose **migrate**. Click **Run**.
8. Google asks you to authorise. Click **Review permissions**, choose your account. If you see "Google hasn't verified this app", click **Advanced → Go to Dad Fit (unsafe)**. It is your own script. Click **Allow**.
9. When it finishes, the **Execution log** at the bottom should say `DONE`. If you see a red error instead, copy it to me. Nothing is changed when it fails.

9b. Now log the 5 Oct session. In the function dropdown choose **backfill** and click **Run**. The log should say `Added: C #7 on 2026-10-05`. (To add other forgotten sessions, edit the `BACKFILL` list at the bottom of `Migrate` first. Running it twice is safe.)

## Part 2. Check the result

Your old data is now in a tab called **Old log (backup)**, unchanged. Check these on the new tabs:

| Tab | What you should see |
|---|---|
| **Log** | 21 rows (20 old + 5 Oct), with `session_no` like `A #1`, `day`, `week`, `on_schedule` (all `Yes`), and `plan_version` |
| **Sets** | 84 rows, one per exercise per workout, with a `total` column |
| **Sport** | 4 rows: rugby, badminton, rugby, rugby |
| **Plan** | A, B and C as they stand now; days Wed, Fri, Mon on the right |
| **Plan history** | A1 to A5, B1 to B5, C1 to C4, each with the date it first applied |
| **Breaks** | one row: 30 Aug to 13 Sep |
| **Summary** | 21 kettlebell sessions, 4 sport, 6 skipped in a planned break |

Three things you should expect:

- **Missed shows 4 until you run backfill (step 9b).** The sheet works out that Mon 28 Sep (C), Wed 30 Sep (A), Fri 2 Oct (B) and Mon 5 Oct (C) have no logged session. You did 5 Oct, so backfill logs it. After that Missed shows 3, and the next session due is A (Wed 7 Oct).
- **Workout #20** had no exercises written down, so its Sets rows are copied from plan B5 and marked `assumed from plan B5 (not recorded)`.
- **Suitcase carries in workouts 2 to 8** have a blank amount, because no duration was recorded.

## Part 3. Secret key and web app

10. Make up a key: long and random, at least 16 characters (three unrelated words plus numbers is fine). Save it in your password manager or a note on your phone. It never goes in GitHub.
11. In Apps Script click the **gear icon (Project Settings)** on the left. Scroll to **Script Properties → Add script property**. Property: `SECRET_KEY`. Value: your key. Click **Save script properties**.
12. Click **Deploy → New deployment**. Click the gear next to "Select type" → **Web app**. Set **Execute as: Me** and **Who has access: Anyone**. Click **Deploy**. Copy the **Web app URL** (ends in `/exec`).
13. "Anyone" only means the address can be reached. Every request without your key is refused and returns no data.

## Part 4. Test it from PowerShell

Replace `PASTE_URL` with your web app URL. It asks for the key when you run it (nothing is saved).

```powershell
$body = @{ key = (Read-Host "Secret key"); action = "load" } | ConvertTo-Json
Invoke-RestMethod -Uri "PASTE_URL" -Method Post -ContentType "text/plain" -Body $body | ConvertTo-Json -Depth 6
```

You should see `ok: true`, `total: 21`, the plan, and the latest entries. With a wrong key you should see `error: bad_key` and nothing else. Do not run an `add` test on your real sheet; if you do, tap Undo on the page or delete the new row.

## Files in this folder

| File | What it is |
|---|---|
| `apps-script/Code.gs` | The web app and tab layout (paste into Apps Script) |
| `apps-script/Migrate.gs` | One-time migration (paste, run once, then you can delete it) |
| `dev/` | Test tools. `node dev/test-backend.js` re-runs the backend tests |
| `index.html`, `config.js` | The OLD phone page. It does not match the new backend and will be replaced in stage 3 |
