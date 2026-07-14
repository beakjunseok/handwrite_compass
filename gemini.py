import json
import os
import re

import requests

API_KEY = os.environ.get("GEMINI_API_KEY")
MODEL = os.environ.get("GEMINI_MODEL", "gemini-2.5-flash")
API_URL = f"https://generativelanguage.googleapis.com/v1beta/models/{MODEL}:generateContent"


def _call_parts(parts: list, timeout: int = 30) -> dict | list:
    if not API_KEY:
        raise RuntimeError("GEMINI_API_KEY is not set")

    payload = {
        "contents": [{"parts": parts}],
        "generationConfig": {"responseMimeType": "application/json"},
    }
    resp = requests.post(API_URL, params={"key": API_KEY}, json=payload, timeout=timeout)
    resp.raise_for_status()
    data = resp.json()
    text = data["candidates"][0]["content"]["parts"][0]["text"]
    text = re.sub(r"^```(json)?|```$", "", text.strip(), flags=re.MULTILINE).strip()
    return json.loads(text)


def _call(prompt: str) -> dict | list:
    return _call_parts([{"text": prompt}])


def _image_parts(data_urls: list) -> list:
    parts = []
    for data_url in data_urls:
        header, _, b64data = data_url.partition(",")
        mime = header.split(";")[0].replace("data:", "") or "image/png"
        parts.append({"inlineData": {"mimeType": mime, "data": b64data}})
    return parts


def analyze_note(content: str) -> dict:
    prompt = f"""다음 필기 내용을 분석해서 JSON으로만 답해줘.
형식: {{"title": "간단한 제목", "keywords": ["키워드1", "키워드2"], "summary": "3~5문장 요약"}}
keywords는 5~8개, 핵심 개념 위주로 뽑아줘. 다른 텍스트 없이 JSON만 출력해.

필기 내용:
{content}
"""
    return _call(prompt)


def analyze_note_image(data_urls: list) -> dict:
    prompt = """이 손글씨 필기 이미지(들)를 읽고 분석해서 JSON으로만 답해줘.
형식: {"title": "간단한 제목", "keywords": ["키워드1", "키워드2"], "summary": "3~5문장 요약", "recognized_text": "인식된 필기 내용 전체 텍스트"}
keywords는 5~8개, 핵심 개념 위주로 뽑아줘. 여러 페이지면 순서대로 이어서 recognized_text를 작성해줘. 다른 텍스트 없이 JSON만 출력해."""
    parts = [{"text": prompt}] + _image_parts(data_urls)
    return _call_parts(parts, timeout=60)


def generate_quiz(content: str, num_questions: int = 5) -> list:
    prompt = f"""다음 필기 내용을 바탕으로 복습용 4지선다 퀴즈를 JSON 배열로 {num_questions}개 만들어줘.
각 항목 형식: {{"question": "...", "options": ["A", "B", "C", "D"], "answer_index": 0, "explanation": "정답 이유"}}
answer_index는 0부터 시작하는 정답 옵션의 인덱스야. 다른 텍스트 없이 JSON 배열만 출력해.

필기 내용:
{content}
"""
    return _call(prompt)
