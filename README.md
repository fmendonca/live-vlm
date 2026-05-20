# NTT Live VLM

Versão: `0.1.13`

Interface web para analisar frames de webcam ou RTSP em tempo quase real usando um endpoint VLM, incluindo modelos como `llama-3.2-11b-vision`.

## Recursos

- Captura de webcam pelo navegador.
- Proxy RTSP via FFmpeg com preview MJPEG.
- Snapshot periódico enviado ao modelo.
- Presets de prompt para segurança, indústria, varejo e tráfego.
- Endpoint configurável com modo vLLM/OpenAI-compatible vision, Ollama local ou JSON simples.
- Histórico de observações com latência.
- Exportação opcional de cada análise em JSONL para Azure Blob ou S3.

## Como rodar

```bash
npm run dev
```

Acesse `http://localhost:3000`.

## Webcam no navegador

A webcam é acessada pelo browser do usuário, não pelo container. Por segurança, navegadores só liberam `getUserMedia` em `localhost` ou páginas HTTPS. Em OpenShift, use a `Route` HTTPS. Se abrir a aplicação por IP/HTTP, o navegador pode bloquear a câmera.

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

### Ollama local

Selecione `Ollama local` no campo `Protocolo` e use o endpoint base do Ollama:

```bash
http://localhost:11434
```

No container/OpenShift, `localhost` é o próprio pod. Para acessar um Ollama fora do pod, use o endereço do serviço/rede, por exemplo `http://ollama.default.svc:11434` ou o host exposto. Também é aceito digitar apenas `IP:11434`; a aplicação normaliza para `http://IP:11434`. A WebUI lista modelos com `GET /api/tags` e envia imagens para `POST /api/chat` com `stream:false`.

## RTSP

O suporte a RTSP depende de `ffmpeg` disponível no PATH. A aplicação cria uma sessão MJPEG local para preview e captura snapshots pelo backend.

## Exportação JSONL

A exportação é desligada por padrão. Quando ligada, cada análise concluída com sucesso gera um objeto `.jsonl` com uma linha JSON e faz upload para Azure Blob ou S3.

Variáveis comuns:

```bash
ANALYSIS_EXPORT_ENABLED=true
ANALYSIS_EXPORT_PROVIDER=azure # azure ou s3
ANALYSIS_EXPORT_PREFIX=analysis
```

Azure Blob usa uma SAS URL apontando para o container:

```bash
AZURE_BLOB_SAS_URL='https://account.blob.core.windows.net/container?sv=...'
```

S3 usa assinatura AWS v4 com variáveis padrão:

```bash
ANALYSIS_EXPORT_PROVIDER=s3
AWS_S3_BUCKET=meu-bucket
AWS_REGION=us-east-1
AWS_ACCESS_KEY_ID=...
AWS_SECRET_ACCESS_KEY=...
# opcional: AWS_SESSION_TOKEN=...
# opcional para S3 compatível: AWS_S3_ENDPOINT=https://s3.example.com
```

Quando a exportação está ligada, os logs do container incluem eventos JSON estruturados:

```json
{"event":"analysis_export_config","enabled":true,"provider":"azure","configured":true}
{"event":"analysis_export_upload_start","provider":"azure","key":"analysis/2026-05-20/...jsonl","bytes":1234}
{"event":"analysis_export_target","provider":"azure","accountHost":"account.blob.core.windows.net","key":"analysis/2026-05-20/...jsonl"}
{"event":"analysis_export_success","provider":"azure","key":"analysis/2026-05-20/...jsonl"}
```

## Container

```bash
podman build --platform linux/amd64 -t quay.io/fcalomen/ntt-lvm:0.1.13 .
podman run --rm -p 3000:3000 quay.io/fcalomen/ntt-lvm:0.1.13
podman push quay.io/fcalomen/ntt-lvm:0.1.13
```

## OpenShift

```bash
oc apply -k openshift
```

O deployment expõe a aplicação na porta interna `3000`, cria `Service` em `8080`, `Route` HTTPS edge e usa `/healthz` para probes.

Se o cluster OpenShift roda em nodes `amd64`, construa a imagem com `--platform linux/amd64`. Sem isso, em Macs Apple Silicon o Podman gera uma imagem `arm64`, causando `Exec format error` no container.
