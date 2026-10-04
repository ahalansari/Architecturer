# Architecturer remote MCP server (OAuth + personal tokens, live viewer, download links).
# docker run -p 5178:5178 -v ./data:/data -e ARCHITECTURER_PUBLIC_URL=https://arch.example.com aalansari/architecturer
# then open /setup with the setup code from `docker logs`.
# Settings: README, "Remote MCP server". compose.yaml runs it behind a Cloudflare Tunnel.

FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
# skip "prepare" (tsc) until the sources are copied; no production dependency has install scripts
RUN npm ci --ignore-scripts
COPY tsconfig.json ./
COPY src ./src
# the path tracer is shared with the browser viewer (types for tsc)
COPY viewer/gpu ./viewer/gpu
# Intel Open Image Denoise (AI denoiser for the path tracer; CUDA on NVIDIA): x86-64 only, arm64 uses the built-in one
ARG TARGETARCH
ARG OIDN_VERSION=2.5.1
RUN mkdir -p /opt/oidn && if [ "$TARGETARCH" = "amd64" ]; then \
      node -e "fetch(process.argv[1]).then(r=>{if(!r.ok)throw new Error(r.status);return r.arrayBuffer()}).then(b=>require('fs').writeFileSync('/tmp/oidn.tgz',Buffer.from(b)))" \
        "https://github.com/RenderKit/oidn/releases/download/v${OIDN_VERSION}/oidn-${OIDN_VERSION}.x86_64.linux.tar.gz" \
      && tar xzf /tmp/oidn.tgz -C /opt/oidn --strip-components=1 && rm /tmp/oidn.tgz && rm -rf /opt/oidn/include /opt/oidn/lib/cmake /opt/oidn/lib/*hip* /opt/oidn/lib/*sycl* /opt/oidn/bin/oidnBenchmark /opt/oidn/bin/oidnTest; \
    fi
RUN npx tsc -p . && npm prune --omit=dev \
 # Dawn (WebGPU) ships every platform's binary: keep this image's
 && cd node_modules/webgpu/dist && for d in *; do [ "$d" = "linux-$(node -p process.arch)" ] || rm -rf "$d"; done

FROM node:22-bookworm-slim
# Vulkan loader for the GPU path tracer; the NVIDIA runtime mounts the driver and its Vulkan ICD into the container
# fonts: plan sheets are SVG rasterised on the server (Liberation Sans = Arial / Helvetica metrics; DejaVu for Arabic)
RUN apt-get update && apt-get install -y --no-install-recommends libvulkan1 libglvnd0 libegl1 libx11-6 libxext6 fonts-liberation2 fonts-dejavu-core \
 && rm -rf /var/lib/apt/lists/* \
 # the NVIDIA runtime mounts libGLX_nvidia (with "graphics") but not always the ICD file that points Vulkan at it
 && mkdir -p /usr/share/vulkan/icd.d \
 && printf '{"file_format_version":"1.0.0","ICD":{"library_path":"libGLX_nvidia.so.0","api_version":"1.3"}}\n' > /usr/share/vulkan/icd.d/nvidia_icd.json
ENV NODE_ENV=production \
    NVIDIA_DRIVER_CAPABILITIES=all \
    TZ=Asia/Kuwait \
    HOST=0.0.0.0 \
    PORT=5178 \
    ARCHITECTURER_WORKDIR=/data/plans \
    ARCHITECTURER_STATE=/data/state \
    ARCHITECTURER_CACHE=/data/cache \
    ARCHITECTURER_WORKERS=1
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /opt/oidn /opt/oidn
COPY package.json ./
COPY bin ./bin
COPY viewer ./viewer
COPY examples ./examples
# Unraid's nobody:users (99:100) owns appdata shares
RUN mkdir -p /data/plans /data/state /data/cache && chown -R 99:100 /data
USER 99:100
VOLUME ["/data"]
EXPOSE 5178
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||5178)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "dist/mcp/http.js"]
