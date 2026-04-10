FROM denoland/deno:2.7.8

# Store module cache at a fixed path independent of the user that runs the process
ENV DENO_DIR=/deno-dir

WORKDIR /app

# Copy manifests first so the deno cache layer is stable when only source changes
COPY deno.json deno.lock ./
COPY src/ ./src/

# Pre-fetch all JSR dependencies and the native libsqlite3.so (--allow-ffi
# triggers the @db/sqlite native binary download at build time so the container
# needs no outbound network access at runtime)
RUN deno cache --frozen --allow-ffi ./src/main.ts

# Drop to non-root for runtime; fix ownership on the cache dir (written as root above)
RUN chown -R deno:deno /deno-dir
RUN mkdir -p /data && chown deno:deno /data

USER deno

# All runtime-writable paths (popfile.db, popfile.cfg, logs/, training/) resolve
# relative to CWD, so set CWD to the data volume rather than /app
WORKDIR /data

VOLUME /data

EXPOSE 8080
EXPOSE 1110
EXPOSE 1995
EXPOSE 1025
EXPOSE 1119

CMD ["deno", "run", \
     "--allow-net", "--allow-read", "--allow-write", "--allow-env", "--allow-ffi", \
     "/app/src/main.ts"]
