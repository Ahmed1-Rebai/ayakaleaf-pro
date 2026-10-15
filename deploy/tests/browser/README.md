# Browser tests

`ai_edit_mode_test.py` drives the real editor with Playwright: the AI assistant's
Manual / Auto edit mode and the reasoning-history patch. It needs the Playwright image
(~3.6 GB), so pull it only when testing and remove it afterwards:

```bash
cd ~/lambdatex
docker run --rm --network host -v "$PWD/deploy/tests/browser:/work" -w /work \
  -e OL_EMAIL="$(sed -n 's/^SEED_ADMIN_EMAIL=//p' .env)" \
  -e OL_PW="$(sed -n 's/^SEED_ADMIN_PASSWORD=//p' .env)" \
  mcr.microsoft.com/playwright/python:v1.55.0-noble \
  sh -c 'pip install -q --break-system-packages playwright==1.55.0 requests && python3 ai_edit_mode_test.py'
docker rmi mcr.microsoft.com/playwright/python:v1.55.0-noble
```

The same command runs the other browser tests: `ai_conversations_test.py` (saved
conversations) and `ai_compiler_test.py` (automatic TeX engine through the assistant and the
Recompile button). Each deletes its project afterwards, also when it fails.

Screenshots go to `/tmp/lambdatex-tests` inside the container (set `LT_TEST_DIR` and
mount a folder to keep them).
