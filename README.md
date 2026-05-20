# NTT Live VLM

Versão: `0.1.8`

Interface web para analisar frames de webcam ou RTSP em tempo quase real usando um endpoint VLM, incluindo modelos como `llama-3.2-11b-vision`.

## Recursos

- Captura de webcam pelo navegador.
- Proxy RTSP via FFmpeg com preview MJPEG.
- Snapshot periódico enviado ao modelo.
- Presets de prompt para segurança, indústria, varejo e tráfego.
- Endpoint configurável com modo vLLM/OpenAI-compatible vision ou JSON simples.
- Histórico de observações com latência.

## Como rodar

```bash
npm run dev
```

Acesse `http://localhost:3000`.

## Configuração do modelo

Use a base do vLLM, como `http://vllm:8000` ou `http://vllm:8000/v1`. A WebUI normaliza a análise para `POST /v1/chat/completions` e a listagem para `GET /v1/models`.

O modo padrão é compatível com APIs vision no formato:

```json
{
  "model": "llama-3.2-11b-vision",
  "messages": [
    {
      "role": "user",
      "content": [
        { "type": "text", "text": "..." },
        { "type": "image_url", "image_url": { "url": "data:image/jpeg;base64,..." } }
      ]
    }
  ]
}
```

Se o seu servidor do modelo vision usa outro contrato, selecione `JSON simples`, que envia:

```json
{
  "model": "llama-3.2-11b-vision",
  "prompt": "...",
  "image": "base64..."
}
```

## RTSP

O suporte a RTSP depende de `ffmpeg` disponível no PATH. A aplicação cria uma sessão MJPEG local para preview e captura snapshots pelo backend.

## Container

```bash
podman build --platform linux/amd64 -t quay.io/fcalomen/ntt-lvm:0.1.8 .
podman run --rm -p 3000:3000 quay.io/fcalomen/ntt-lvm:0.1.8
podman push quay.io/fcalomen/ntt-lvm:0.1.8
```

## OpenShift

```bash
oc apply -k openshift
```

O deployment expõe a aplicação na porta interna `3000`, cria `Service` em `8080`, `Route` HTTPS edge e usa `/healthz` para probes.

Se o cluster OpenShift roda em nodes `amd64`, construa a imagem com `--platform linux/amd64`. Sem isso, em Macs Apple Silicon o Podman gera uma imagem `arm64`, causando `Exec format error` no container.
