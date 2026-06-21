# weave self-authored-skill sandbox (ADR-0018). The image holds ONLY the executor entry — the
# skill is mounted read-only at run time, never baked in. Run confined:
#   docker run --rm -i --network none --read-only --cap-drop ALL \
#     --security-opt no-new-privileges --pids-limit 64 --memory 256m --cpus 1 \
#     --tmpfs /tmp:size=16m -v <skill>:/skill/s.mjs:ro weave-sandbox /skill/s.mjs
FROM node:22-alpine
COPY docker-skill-entry.mjs /app/entry.mjs
USER node
ENTRYPOINT ["node", "/app/entry.mjs"]
