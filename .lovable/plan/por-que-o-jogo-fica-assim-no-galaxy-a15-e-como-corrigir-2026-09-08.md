# Por que o jogo fica assim no Galaxy A15 — e como corrigir

## O que a captura mostra

Três problemas visuais distintos ao mesmo tempo:

1. **Imagem serrilhada / "quadriculada"** — o jogo reduz sozinho a resolução interna quando detecta queda de FPS. No A15 ela cai até 0.6x do tamanho da tela (com DPR 2.8 do aparelho, isso vira uma imagem bem menor esticada), gerando as bordas em degrau vistas nas plantas e na porta.
2. **Personagem estourada em preto e branco** — o modelo usa materiais toon (MToon). Ele recebe sol forte + duas luzes pontuais de preenchimento coladas no corpo, e o tom filmico com exposição 1.25 satura tudo: pele e roupa viram branco puro, e as zonas de sombra viram preto chapado, perdendo todo o detalhe.
3. **Cena escura ao redor** — sombras são desativadas automaticamente no celular quando o FPS cai, o que muda a iluminação de forma inconsistente entre momentos.

## O que vou mudar

**Resolução**
- Elevar o piso da resolução interna no celular (de 0.6 para ~0.9) e o teto para ~1.3, para a imagem não degradar a esse ponto.
- Suavizar o passo do ajuste automático, evitando oscilar de nitidez durante a partida.

**Iluminação da personagem (a causa do "estourado")**
- Reduzir bastante as luzes pontuais de preenchimento e transformá-las em preenchimento suave, não em holofote.
- Baixar a exposição do tom filmico e limitar o ganho aplicado às cores de sombra do MToon (hoje multiplicadas por 1.25, o que estoura os tons claros).
- Ajustar sol/hemisférica para manter contraste sem clipping, deixando pele, roupa e cabelo com gradação visível.

**Estabilidade visual**
- Em vez de desligar sombras por completo quando cai o FPS, reduzir a frequência de atualização e o tamanho do mapa de sombra, mantendo a iluminação consistente.

**Menu de Gráficos**
- Adicionar em Configurações uma escolha: Baixo / Médio / Alto, que fixa resolução, sombras e antialiasing. Assim você pode forçar "Alto" no A15 se o desempenho permitir, em vez de depender só do ajuste automático.

## Detalhes técnicos

Tudo em `src/components/Game.tsx` (`isLowPower`, `minPixelRatio`/`maxPixelRatio`, bloco adaptativo do loop, `charFill`/`charRim`, `toneMappingExposure`, patch de `shadeColorFactor`) e em `src/components/BunnyMenu.tsx` para o seletor de qualidade persistido em `localStorage` e lido pelo jogo via as mesmas settings globais já usadas para sensibilidade.

## Verificação

Rodar o jogo em viewport de celular via Playwright, capturar telas em parada e em movimento, comparar nitidez e a leitura da personagem contra a captura enviada, e conferir que não há erros de console nem queda de FPS.
