// Cloudflare Worker: 카카오맵 비공식 place-api(panel3) 메뉴 데이터 프록시
//
// 용도: place-api.map.kakao.com은 CORS가 카카오 자체 도메인으로만 제한돼 있어
//       lunch-recommender.html(GitHub Pages)에서 직접 fetch가 불가능함.
//       이 Worker가 대신 카카오에 요청(Origin을 place.map.kakao.com으로 위장)하고,
//       필요한 필드만 추려서 CORS 허용 응답으로 돌려준다.
//
// 호출 예: https://<your-worker>.workers.dev/?placeId=1454070757
//
// 주의: place-api.map.kakao.com은 카카오맵 웹의 비공식 내부 API이며 문서화되어 있지
//       않다. 응답 구조가 예고 없이 바뀌거나 접근이 막힐 수 있으므로, 실패 시
//       호출하는 쪽(lunch-recommender.html)에서 기존 수동입력/키워드 추정 방식으로
//       폴백하도록 설계돼 있다. 개인용 소규모 도구 용도로만 사용할 것.

const KAKAO_API = 'https://place-api.map.kakao.com/places/panel3/';
const CACHE_SECONDS = 60 * 60 * 24; // 1일 — 같은 식당 반복 조회 시 카카오 재호출 방지

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*', // 필요시 배포 도메인으로 좁혀도 됨
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
  };
}

function json(obj, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      ...corsHeaders(),
      ...extraHeaders,
    },
  });
}

export default {
  async fetch(request) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders() });
    }

    const url = new URL(request.url);
    const placeId = url.searchParams.get('placeId');

    if (!placeId || !/^\d+$/.test(placeId)) {
      return json({ error: 'placeId 쿼리 파라미터가 필요합니다 (숫자만).' }, 400);
    }

    // Cloudflare Cache API로 응답 캐싱 (같은 placeId 반복 요청 시 카카오 재호출 방지)
    const cache = caches.default;
    const cacheKey = new Request(url.toString(), request);
    const cached = await cache.match(cacheKey);
    if (cached) return cached;

    let kakaoResp;
    try {
      kakaoResp = await fetch(KAKAO_API + placeId, {
        headers: {
          'accept': 'application/json, text/plain, */*',
          'accept-language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7',
          'appversion': '6.6.0',
          'cache-control': 'no-cache',
          'pragma': 'no-cache',
          'dnt': '1',
          'origin': 'https://place.map.kakao.com',
          'referer': 'https://place.map.kakao.com/',
          'pf': 'PC',
          'priority': 'u=1, i',
          'sec-ch-ua': '"Chromium";v="152", "Not?A_Brand";v="24", "Google Chrome";v="152"',
          'sec-ch-ua-mobile': '?0',
          'sec-ch-ua-platform': '"Windows"',
          'sec-fetch-dest': 'empty',
          'sec-fetch-mode': 'cors',
          'sec-fetch-site': 'same-site',
          'user-agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36',
        },
      });
    } catch (e) {
      return json({ error: 'kakao 요청 실패', detail: String(e) }, 502);
    }

    if (!kakaoResp.ok) {
      return json({ error: `kakao api status ${kakaoResp.status}` }, 502);
    }

    let data;
    try {
      data = await kakaoResp.json();
    } catch (e) {
      return json({ error: 'kakao 응답 파싱 실패', detail: String(e) }, 502);
    }

    const rawItems = data?.menu?.menus?.items || [];
    const result = {
      placeId,
      menuType: data?.menu?.menus?.menu_type || null,
      updatedAt: data?.menu?.menus?.items_updated_at || null,
      items: rawItems.map((it) => ({
        name: it.name,
        price: it.price ?? null,
        isRecommend: !!it.is_recommend,
        recommendReasons: it.recommend_reasons || [],
        description: it.ai_mate_desc || null,
        photoUrl: it.photo_url || null,
      })),
    };

    const response = json(result, 200, {
      'Cache-Control': `public, max-age=${CACHE_SECONDS}`,
    });
    await cache.put(cacheKey, response.clone());
    return response;
  },
};
