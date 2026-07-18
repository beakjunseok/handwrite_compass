import os

from dotenv import load_dotenv
from flask import Flask, jsonify, render_template, request
from flask_cors import CORS
from supabase import create_client

import gemini

load_dotenv(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".env"))

app = Flask(__name__)
CORS(app)

SUPABASE_URL = os.environ.get("SUPABASE_URL")
SUPABASE_KEY = os.environ.get("SUPABASE_KEY")
EMAIL_DOMAIN = "gmail.com"
EMAIL_PREFIX = "notequizapp-"


def require_config():
    if not (SUPABASE_URL and SUPABASE_KEY):
        raise RuntimeError("SUPABASE_URL / SUPABASE_KEY is not configured yet")


def anon_client():
    require_config()
    return create_client(SUPABASE_URL, SUPABASE_KEY)


def authed_client():
    """Builds a Supabase client scoped to the caller's access token so RLS (auth.uid()) applies."""
    require_config()
    token = request.headers.get("Authorization", "").removeprefix("Bearer ").strip()
    if not token:
        return None, None
    client = create_client(SUPABASE_URL, SUPABASE_KEY)
    client.postgrest.auth(token)
    try:
        user = client.auth.get_user(token).user
    except Exception:
        return None, None
    if not user:
        return None, None
    return client, user


def username_to_email(username: str) -> str:
    return f"{EMAIL_PREFIX}{username}@{EMAIL_DOMAIN}"


@app.route("/")
def index():
    return render_template("index.html")


@app.route("/api/auth/signup", methods=["POST"])
def signup():
    data = request.get_json(force=True)
    username = (data.get("username") or "").strip().lower()
    password = data.get("password") or ""
    if not username or not password:
        return jsonify({"error": "아이디와 비밀번호를 입력하세요"}), 400

    client = anon_client()
    try:
        res = client.auth.sign_up(
            {
                "email": username_to_email(username),
                "password": password,
                "options": {"data": {"username": username}},
            }
        )
    except Exception as e:
        return jsonify({"error": str(e)}), 400

    if not res.session:
        return (
            jsonify(
                {
                    "error": "회원가입은 되었지만 자동 로그인이 안 됐습니다. Supabase Authentication 설정에서 "
                    "'Confirm email'을 꺼주세요."
                }
            ),
            400,
        )
    return jsonify({"access_token": res.session.access_token, "username": username})


@app.route("/api/auth/login", methods=["POST"])
def login():
    data = request.get_json(force=True)
    username = (data.get("username") or "").strip().lower()
    password = data.get("password") or ""

    client = anon_client()
    try:
        res = client.auth.sign_in_with_password(
            {"email": username_to_email(username), "password": password}
        )
    except Exception:
        return jsonify({"error": "아이디 또는 비밀번호가 올바르지 않습니다"}), 401
    return jsonify({"access_token": res.session.access_token, "username": username})


@app.route("/api/notes", methods=["GET"])
def list_notes():
    client, user = authed_client()
    if not user:
        return jsonify({"error": "로그인이 필요합니다"}), 401
    keyword = request.args.get("keyword", "").strip()
    q = request.args.get("q", "").strip()
    tag = request.args.get("tag", "").strip()
    favorite_only = request.args.get("favorite") == "1"

    query = client.table("notes").select("*").order("created_at", desc=True)
    if keyword:
        query = query.contains("keywords", [keyword])
    if tag:
        query = query.contains("tags", [tag])
    if favorite_only:
        query = query.eq("is_favorite", True)
    if q:
        query = query.or_(f"content.ilike.%{q}%,title.ilike.%{q}%")
    res = query.execute()
    return jsonify(res.data)


@app.route("/api/notes", methods=["POST"])
def create_note():
    client, user = authed_client()
    if not user:
        return jsonify({"error": "로그인이 필요합니다"}), 401

    data = request.get_json(force=True)
    title = (data.get("title") or "").strip()
    note_type = data.get("note_type") or "text"
    existing_id = data.get("id")

    if note_type == "canvas":
        pages = data.get("pages") or []
        if not pages:
            return jsonify({"error": "pages is required for canvas notes"}), 400
        pdf_text = data.get("pdf_text") or ""
        analysis = gemini.analyze_note_image(pages, extra_text=pdf_text)
        row = {
            "title": title or analysis.get("title") or "제목 없음",
            "content": analysis.get("recognized_text", ""),
            "keywords": analysis.get("keywords", []),
            "summary": analysis.get("summary", ""),
            "note_type": "canvas",
            "pages": pages,
        }
    else:
        content = (data.get("content") or "").strip()
        if not content:
            return jsonify({"error": "content is required"}), 400
        analysis = gemini.analyze_note(content)
        row = {
            "title": title or analysis.get("title") or "제목 없음",
            "content": content,
            "keywords": analysis.get("keywords", []),
            "summary": analysis.get("summary", ""),
            "note_type": "text",
        }

    if existing_id:
        res = client.table("notes").update(row).eq("id", existing_id).execute()
        if not res.data:
            return jsonify({"error": "note not found"}), 404
        return jsonify(res.data[0])

    row["user_id"] = user.id
    res = client.table("notes").insert(row).execute()
    return jsonify(res.data[0]), 201


@app.route("/api/notes/<note_id>", methods=["GET"])
def get_note(note_id):
    client, user = authed_client()
    if not user:
        return jsonify({"error": "로그인이 필요합니다"}), 401
    res = client.table("notes").select("*").eq("id", note_id).single().execute()
    return jsonify(res.data)


@app.route("/api/notes/<note_id>", methods=["PUT"])
def update_note(note_id):
    """Lightweight raw update (autosave, tags, favorite) that skips the Gemini analysis step."""
    client, user = authed_client()
    if not user:
        return jsonify({"error": "로그인이 필요합니다"}), 401

    data = request.get_json(force=True)
    row = {}
    if "title" in data:
        row["title"] = (data.get("title") or "").strip() or "제목 없음"
    if "content" in data:
        row["content"] = data.get("content") or ""
    if "pages" in data:
        row["pages"] = data.get("pages")
    if "tags" in data:
        row["tags"] = data.get("tags") or []
    if "is_favorite" in data:
        row["is_favorite"] = bool(data.get("is_favorite"))
    if not row:
        return jsonify({"error": "no fields to update"}), 400

    res = client.table("notes").update(row).eq("id", note_id).execute()
    if not res.data:
        return jsonify({"error": "note not found"}), 404
    return jsonify(res.data[0])


@app.route("/api/notes/<note_id>", methods=["DELETE"])
def delete_note(note_id):
    client, user = authed_client()
    if not user:
        return jsonify({"error": "로그인이 필요합니다"}), 401
    client.table("notes").delete().eq("id", note_id).execute()
    return "", 204


@app.route("/api/notes/<note_id>/quiz", methods=["POST"])
def create_quiz(note_id):
    client, user = authed_client()
    if not user:
        return jsonify({"error": "로그인이 필요합니다"}), 401

    note_res = client.table("notes").select("*").eq("id", note_id).single().execute()
    note = note_res.data
    if not note:
        return jsonify({"error": "note not found"}), 404

    questions = gemini.generate_quiz(note["content"])
    row = {"note_id": note_id, "questions": questions, "user_id": user.id}
    res = client.table("quizzes").insert(row).execute()
    return jsonify(res.data[0]), 201


@app.route("/api/notes/<note_id>/quizzes", methods=["GET"])
def list_quizzes(note_id):
    client, user = authed_client()
    if not user:
        return jsonify({"error": "로그인이 필요합니다"}), 401
    res = (
        client.table("quizzes")
        .select("*")
        .eq("note_id", note_id)
        .order("created_at", desc=True)
        .execute()
    )
    return jsonify(res.data)


@app.route("/api/quizzes/<quiz_id>", methods=["GET"])
def get_quiz(quiz_id):
    client, user = authed_client()
    if not user:
        return jsonify({"error": "로그인이 필요합니다"}), 401
    res = client.table("quizzes").select("*").eq("id", quiz_id).single().execute()
    return jsonify(res.data)


@app.errorhandler(RuntimeError)
def handle_runtime_error(err):
    return jsonify({"error": str(err)}), 503


if __name__ == "__main__":
    app.run(debug=True, port=5050)
