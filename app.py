import streamlit as st
import pandas as pd
import numpy as np
import altair as alt
import matplotlib.pyplot as plt
import io
import os
import json
from datetime import datetime, timedelta
import logging

# Load .env file if present
try:
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:
    pass  # dotenv not available, will use system env vars only

# Helper to read configuration values first from environment, then from
# Streamlit secrets (so the same code works locally with .env or in
# Streamlit Cloud with st.secrets).
def get_config(key, default=None):
    """Return configuration value from environment or Streamlit secrets.

    Priority: os.environ -> st.secrets -> default
    """
    # 1) check OS environment
    val = os.environ.get(key)
    if val is not None and val != '':
        return val

    # 2) check Streamlit secrets (works on Streamlit Cloud)
    try:
        # st.secrets works like a dict; it may contain nested dicts
        if key in st.secrets:
            return st.secrets[key]

        # try to find the key inside nested sections (e.g., [postgres])
        for v in st.secrets.values():
            if isinstance(v, dict) and key in v:
                return v[key]
    except Exception:
        # if streamlit isn't available or secrets missing, ignore
        pass

    return default


def sanitize_for_streamlit(df: pd.DataFrame, max_rows: int | None = None) -> pd.DataFrame:
    """Return a copy of df safe to pass to Streamlit (convert non-JSON-serializable
    object columns to strings). Optionally limit rows with max_rows.
    """
    if df is None or df.empty:
        return df.copy()

    out = df.copy()
    if max_rows is not None:
        out = out.head(max_rows).copy()

    def _safe_serialize(x):
        # keep NaN/None
        if pd.isna(x):
            return x
        # common primitives and datetimes — keep as-is
        if isinstance(x, (str, int, float, bool, pd.Timestamp, datetime, timedelta)):
            return x
        # lists/dicts/other objects -> try JSON, fallback to str
        try:
            return json.dumps(x, default=str, ensure_ascii=False)
        except Exception:
            try:
                return str(x)
            except Exception:
                return repr(x)

    # Convert ALL object columns to string to avoid pyarrow serialization issues
    for col in out.columns:
        if out[col].dtype == 'object':
            out[col] = out[col].apply(_safe_serialize)

    # ensure datetimes are converted to strings to avoid timezone/pyarrow issues
    for dt_col in out.select_dtypes(include=['datetime64[ns]', 'datetimetz']).columns:
        out[dt_col] = out[dt_col].dt.strftime('%Y-%m-%d %H:%M:%S')
        
    # Convert any remaining complex dtypes to strings
    for col in out.columns:
        if out[col].dtype == 'object' or str(out[col].dtype).startswith('category'):
            out[col] = out[col].astype(str)
            
    # Reset index to avoid any index-related serialization issues
    out = out.reset_index(drop=True)

    return out


def diagnose_problem_columns(df: pd.DataFrame, sample_rows: int = 10) -> None:
    """Print diagnostic info for columns that contain non-primitive values.

    This prints the column name, dtype and up to `sample_rows` values with their
    Python types to help debug pyarrow/streamlit serialization issues on Cloud.
    """
    if df is None or df.empty:
        print("[diagnose] dataframe empty or None")
        return

    def _is_primitive(x):
        return isinstance(x, (str, int, float, bool, type(None))) or pd.isna(x) or isinstance(x, (pd.Timestamp, datetime, timedelta))

    print("[diagnose] Starting problem column detection...")
    problematic = []
    head = df.head(sample_rows)
    for col in df.columns:
        # if column dtype object, check sample for non-primitive values
        if df[col].dtype == 'object':
            has_non_prim = head[col].apply(lambda v: not _is_primitive(v)).any()
            if has_non_prim:
                problematic.append(col)

    if not problematic:
        print("[diagnose] No problematic object columns detected in sample.")
        return

    print(f"[diagnose] Problematic columns found: {problematic}")
    for col in problematic:
        print(f"[diagnose] Column: '{col}' dtype={df[col].dtype}")
        for i, val in enumerate(head[col].tolist()):
            try:
                tname = type(val).__name__
            except Exception:
                tname = 'UNKNOWN'
            # show truncated repr to avoid huge logs
            try:
                vrepr = repr(val)
            except Exception:
                vrepr = '<unrepresentable>'
            if len(vrepr) > 200:
                vrepr = vrepr[:200] + '...'
            print(f"  [{i}] type={tname} value={vrepr}")

    print("[diagnose] End of diagnostic output")

# Optional DB connectors
try:
    from pymongo import MongoClient
except Exception:
    MongoClient = None

try:
    from sqlalchemy import create_engine, text
except Exception:
    create_engine = None


def load_mongodb_logs():
    """Carrega logs do MongoDB para análise de conversação"""
    mongo_uri = get_config("MONGO_URI")
    if not mongo_uri or MongoClient is None:
        return pd.DataFrame()
    
    try:
        print("🔄 Conectando ao MongoDB para logs...")
        client = MongoClient(mongo_uri)
        
        # Extract database name from URI
        if '/' in mongo_uri and '?' in mongo_uri:
            db_name = mongo_uri.split('/')[-1].split('?')[0]
            if db_name:
                db = client[db_name]
            else:
                db = client['logs_sprint4']
        else:
            db = client['logs_sprint4']
        
        # Find the logs collection
        coll = db['denuncias_logs']
        
        # Load recent logs (last 30 days)
        cutoff = datetime.now() - timedelta(days=30)
        docs = list(coll.find({"timestamp": {"$gte": cutoff}}))
        print(f"📊 MongoDB: {len(docs)} logs encontrados")
        
        if docs:
            df_logs = pd.json_normalize(docs)
            if 'timestamp' in df_logs.columns:
                df_logs['timestamp'] = pd.to_datetime(df_logs['timestamp'])
            
            # Converter ObjectId para string para evitar erro do Arrow
            if '_id' in df_logs.columns:
                df_logs['_id'] = df_logs['_id'].astype(str)
            
            return df_logs
        
        return pd.DataFrame()
    except Exception as e:
        print(f"❌ Erro ao carregar logs do MongoDB: {e}")
        return pd.DataFrame()

def combine_postgres_and_mongo_data():
    """Combina dados do Postgres (denúncias) com logs do MongoDB"""
    print("🔄 Iniciando carregamento combinado de dados...")
    
    # 1. Carregar denúncias do Postgres (dados estruturados de negócio)
    database_url = get_config('DATABASE_URL')
    pg_data = pd.DataFrame()
    
    if database_url and create_engine is not None:
        pg_data = load_denuncias_from_postgres(database_url)
    
    # 2. Carregar logs do MongoDB (dados de conversação/eventos)
    mongo_logs = load_mongodb_logs()
    
    # 3. Se temos dados do Postgres, usar como base
    if not pg_data.empty:
        print(f"✅ Usando {len(pg_data)} denúncias do Postgres como base")
        df_combined = pg_data.copy()
        
        # Mapear campos básicos
        df_combined['conversation_id'] = df_combined.get('protocolo', [f'conv_{i}' for i in range(len(df_combined))])
        df_combined['priority'] = df_combined.get('prioridade', 'Média')
        df_combined['protocol'] = df_combined.get('protocolo', '')
        
        # Definir valores padrão
        df_combined['channel'] = 'web'
        df_combined['slots_filled'] = 6
        df_combined['slots_total'] = 6
        df_combined['intent_final'] = 'AbrirChamadoSuporte'
        df_combined['abandoned'] = False
        
        # Valores baseados na lógica de negócio
        df_combined['escalated'] = (df_combined.get('prioridade') == 'Alta')
        
        # Para dados do Postgres, não simular completed_at - usar dados reais se disponíveis
        # df_combined['completed_at'] será NaT se não existir no Postgres
        
        # 4. Se temos logs do MongoDB, enriquecer com dados básicos de conversação
        if not mongo_logs.empty:
            print(f"🔗 Enriquecendo com {len(mongo_logs)} logs do MongoDB...")
            
            # Extrair informações de fallback dos logs
            fallback_logs = mongo_logs[
                mongo_logs.get('message', '').astype(str).str.contains('Fallback detectado', na=False) |
                (mongo_logs.get('intentName', '') == 'Default Fallback Intent')
            ]
            
            # Mapear fallbacks por protocolo (se disponível nos logs)
            fallback_protocols = set()
            for _, log in fallback_logs.iterrows():
                protocol = log.get('protocolo') or log.get('context.protocolo')
                if protocol:
                    fallback_protocols.add(protocol)
            
            # Aplicar informações de fallback
            df_combined['fallback'] = df_combined['protocolo'].isin(fallback_protocols)
            df_combined['fallback_phrase'] = None
            
            # Para protocolos com fallback, definir frase exemplo
            if fallback_protocols:
                sample_phrases = ["não entendi", "poderia repetir", "erro"]
                for i, row in df_combined.iterrows():
                    if row['fallback']:
                        df_combined.at[i, 'fallback_phrase'] = np.random.choice(sample_phrases)
            
            # Extrair informações de notificação (SendGrid logs)
            notification_logs = mongo_logs[
                mongo_logs.get('component', '').astype(str).str.contains('SendGrid', na=False)
            ]
            
            # Mapear notificações por protocolo
            notification_protocols = {}
            for _, log in notification_logs.iterrows():
                protocol = log.get('protocolo') or log.get('context.protocolo')
                if protocol and pd.notna(log.get('timestamp')):
                    if protocol not in notification_protocols:
                        notification_protocols[protocol] = log['timestamp']
                    else:
                        # Pegar a primeira notificação
                        if log['timestamp'] < notification_protocols[protocol]:
                            notification_protocols[protocol] = log['timestamp']
            
            # Aplicar timestamps de notificação
            df_combined['notification_sent_at'] = pd.NaT
            for protocol, timestamp in notification_protocols.items():
                mask = df_combined['protocolo'] == protocol
                df_combined.loc[mask, 'notification_sent_at'] = timestamp
        
        else:
            # Sem logs do MongoDB, simular dados de conversação
            print("⚠️ Sem logs do MongoDB, simulando dados de conversação...")
            df_combined['fallback'] = np.random.choice([True, False], len(df_combined), p=[0.1, 0.9])
            df_combined['fallback_phrase'] = None
            
            # Para alta prioridade, simular notificação em 5-15 minutos
            df_combined['notification_sent_at'] = pd.NaT
            alta_prioridade_mask = (df_combined.get('prioridade') == 'Alta')
            if alta_prioridade_mask.any():
                notif_minutes = np.random.uniform(5, 15, alta_prioridade_mask.sum())
                df_combined.loc[alta_prioridade_mask, 'notification_sent_at'] = (
                    df_combined.loc[alta_prioridade_mask, 'created_at'] + 
                    pd.to_timedelta(notif_minutes, unit='minutes')
                )
        
        # Armazenar logs do MongoDB separadamente para aba específica
        df_combined.attrs['mongo_logs'] = mongo_logs
        
        print(f"✅ Dataset combinado: {len(df_combined)} registros")
        return df_combined
    
    # 4. Se não temos Postgres, tentar apenas MongoDB
    elif not mongo_logs.empty:
        print("🔄 Usando apenas logs do MongoDB...")
        sessions_df = transform_logs_to_sessions(mongo_logs)
        if len(sessions_df) > 0:
            return sessions_df
    
    # 5. Último recurso: dados sintéticos
    print("⚠️ Gerando dados sintéticos...")
    return generate_synthetic_data()

def generate_synthetic_data(num_rows: int = 500):
    """Gera dados sintéticos quando não há fontes reais disponíveis"""
    rng = np.random.default_rng(42)
    start = datetime.now() - timedelta(days=90)
    channels = ["web", "whatsapp", "facebook", "telegram"]
    ufs = ["sp", "rj", "mg", "rs", "ba"]
    priorities = ["Alta", "Média", "Baixa"]

    rows = []
    for i in range(num_rows):
        created_at = start + timedelta(days=int(rng.integers(0, 90)),
                                       hours=int(rng.integers(0, 24)),
                                       minutes=int(rng.integers(0, 60)))
        duration = timedelta(minutes=int(rng.integers(1, 60*48)))
        completed_at = created_at + duration
        
        pr = rng.choice(priorities, p=[0.15, 0.35, 0.5])
        notification_delay = None
        if pr == "Alta":
            if rng.random() < 0.85:
                notification_delay = timedelta(minutes=int(rng.integers(1, 10)))
            else:
                notification_delay = timedelta(minutes=int(rng.integers(11, 60*6)))
        notification_sent_at = (created_at + notification_delay) if notification_delay else pd.NaT

        slots_total = 6
        abandoned = rng.random() < 0.08
        if abandoned:
            slots_filled = rng.integers(0, slots_total)
        else:
            slots_filled = rng.integers(3, slots_total + 1)

        fallback = rng.random() < 0.12
        fallback_phrase = None
        if fallback:
            sample_fallbacks = ["não entendi", "poderia repetir", "o que você quis dizer", "erro", "não sei"]
            fallback_phrase = rng.choice(sample_fallbacks)

        escalated = (pr == "Alta") and (rng.random() < 0.6)
        channel = rng.choice(channels)
        uf = rng.choice(ufs)

        rows.append({
            "conversation_id": f"conv_{i}",
            "channel": channel,
            "uf": uf,
            "priority": pr,
            "created_at": created_at,
            "completed_at": completed_at if not abandoned else pd.NaT,
            "notification_sent_at": notification_sent_at,
            "fallback": fallback,
            "fallback_phrase": fallback_phrase,
            "slots_filled": int(slots_filled),
            "slots_total": slots_total,
            "escalated": escalated,
            "abandoned": abandoned,
            "intent_final": "create_report" if not abandoned else "fallback",
            "protocol": f"SUP-{created_at.strftime('%Y%m%d')}-{i:05d}"
        })

    return pd.DataFrame(rows)

@st.cache_data
def load_or_generate_data(num_rows: int = 500):
    """Função principal que carrega dados combinando Postgres + MongoDB"""
    
    # Verificar se existe arquivo CSV local primeiro
    csv_path = os.path.join(os.path.dirname(__file__), "logs.csv")
    if os.path.exists(csv_path):
        print("✅ Encontrado logs.csv, carregando...")
        df = pd.read_csv(csv_path, parse_dates=["created_at", "completed_at", "notification_sent_at"])
        return df
    
    # Combinar dados do Postgres (denúncias) + MongoDB (logs)
    return combine_postgres_and_mongo_data()


def debug_mongo_logs(df_logs: pd.DataFrame):
    """Debug function to understand MongoDB log structure"""
    print("🔍 DEBUG MongoDB Logs:")
    print(f"  Total logs: {len(df_logs)}")
    print(f"  Colunas: {df_logs.columns.tolist()}")
    
    # Check for session identifiers
    session_cols = [c for c in df_logs.columns if 'session' in c.lower() or 'dialogflow' in c.lower()]
    print(f"  Colunas de sessão encontradas: {session_cols}")
    
    # Check sample data
    if len(df_logs) > 0:
        print(f"  Amostra dos primeiros registros:")
        for i in range(min(3, len(df_logs))):
            print(f"    [{i}]: {dict(df_logs.iloc[i])}")
    
    # Check for context fields
    context_cols = [c for c in df_logs.columns if c.startswith('context.')]
    print(f"  Colunas de contexto: {context_cols}")

def transform_logs_to_sessions(df_logs: pd.DataFrame) -> pd.DataFrame:
    """
    Recebe um dataframe de logs (cada linha é um evento salvo no Mongo) e agrega por sessão
    retornando um dataframe com colunas compatíveis com o restante do app (aproximação).
    """
    debug_mongo_logs(df_logs)  # Debug info
    
    # normalize possible nested fields
    # contexto provavelmente em campos de root (protocolo, intentName, dialogflowSessionId, queryText)
    df = df_logs.copy()
    # Ensure timestamp
    if 'timestamp' in df.columns:
        df['timestamp'] = pd.to_datetime(df['timestamp'], errors='coerce')
    
    # Try to find session ID in various possible locations
    session_id_col = None
    possible_session_cols = [
        'dialogflowSessionId', 'session_id', 'sessionId',
        'context.dialogflowSessionId', 'context.session_id',
        'protocolo'  # Use protocolo as fallback session identifier
    ]
    
    for col in possible_session_cols:
        if col in df.columns and df[col].notna().any():
            df['session_id'] = df[col]
            session_id_col = col
            print(f"  ✅ Usando '{col}' como identificador de sessão")
            break
    
    if session_id_col is None:
        print("  ⚠️ Nenhum identificador de sessão encontrado, usando índice")
        df['session_id'] = df.index.astype(str)

    # intent name may be in intentName or context.intentName
    if 'intentName' in df.columns:
        df['intentName'] = df['intentName']
    elif 'context.intentName' in df.columns:
        df['intentName'] = df['context.intentName']

    # queryText
    if 'queryText' in df.columns:
        df['queryText'] = df['queryText']
    elif 'context.queryText' in df.columns:
        df['queryText'] = df['context.queryText']

    # protocolo, prioridade, uf may be in root fields
    for col in ['protocolo', 'prioridade', 'uf', 'channel']:
        if col not in df.columns and f'context.{col}' in df.columns:
            df[col] = df[f'context.{col}']

    # Group by session and compute summary
    sessions = []
    unique_sessions = df['session_id'].dropna().unique()
    print(f"  📊 Sessões únicas encontradas: {len(unique_sessions)}")
    
    grouped = df.sort_values('timestamp').groupby('session_id')
    for session_id, grp in grouped:
        if pd.isna(session_id) or session_id == '' or session_id == 'None':
            continue
            
        created_at = grp['timestamp'].min()
        # completion: look for logs where message contains 'concluído' or 'Fluxo' concluído
        completed_rows = grp[grp.get('message', '').astype(str).str.contains('concluído|concluido|Fluxo', case=False, na=False)]
        completed_at = completed_rows['timestamp'].min() if not completed_rows.empty else pd.NaT
        
        # fallback: intentName == 'Default Fallback Intent' or message contains 'Fallback detectado'
        fallback_flag = False
        fallback_phrase = None
        if 'intentName' in grp.columns and (grp['intentName'] == 'Default Fallback Intent').any():
            fallback_flag = True
            q = grp.loc[grp['intentName'] == 'Default Fallback Intent']
            if 'queryText' in q.columns:
                fallback_phrase = q['queryText'].iloc[0]
        elif grp.get('message', '').astype(str).str.contains('Fallback detectado', na=False).any():
            fallback_flag = True
            
        # notification: look for SendGrid logs
        notif_rows = grp[grp.get('component', '').astype(str).str.contains('SendGrid', na=False)]
        notification_sent_at = notif_rows['timestamp'].min() if not notif_rows.empty else pd.NaT

        # priority/uf if present
        priority = grp.get('prioridade').dropna().iloc[0] if 'prioridade' in grp.columns and not grp.get('prioridade').dropna().empty else None
        uf = grp.get('uf').dropna().iloc[0] if 'uf' in grp.columns and not grp.get('uf').dropna().empty else None
        channel = grp.get('channel').dropna().iloc[0] if 'channel' in grp.columns and not grp.get('channel').dropna().empty else None

        sessions.append({
            'conversation_id': str(session_id),
            'channel': channel or 'web',  # Changed from 'unknown' to 'web'
            'uf': (uf or '').lower() if uf else 'sp',  # Changed from 'n/i' to 'sp'
            'priority': priority or 'Média',  # Changed from 'N/I' to 'Média'
            'created_at': created_at,
            'completed_at': completed_at,
            'notification_sent_at': notification_sent_at,
            'fallback': fallback_flag,
            'fallback_phrase': fallback_phrase,
            'slots_filled': 6,  # Default value instead of NaN
            'slots_total': 6,
            'escalated': not pd.isna(notification_sent_at),
            'abandoned': pd.isna(completed_at),
            'intent_final': 'AbrirChamadoSuporte',
            'protocol': grp.get('protocolo').dropna().iloc[0] if 'protocolo' in grp.columns and not grp.get('protocolo').dropna().empty else f"MONGO-{session_id}"
        })

    result_df = pd.DataFrame(sessions)
    print(f"  ✅ Processadas {len(result_df)} sessões do MongoDB")
    return result_df


def load_denuncias_from_postgres(database_url: str) -> pd.DataFrame:
    """
    Conecta ao Postgres via SQLAlchemy e retorna a tabela 'denuncias' como DataFrame.
    """
    if create_engine is None:
        print("SQLAlchemy não disponível - usando dados sintéticos para métricas de negócio")
        return pd.DataFrame()
    try:
        engine = create_engine(database_url)
        with engine.connect() as conn:
            # Buscar todas as colunas disponíveis
            df = pd.read_sql(text('''
                SELECT protocolo, nome, email, descricao, prioridade, status, 
                       uf, created_at, titulo, data_ocorrido
                FROM denuncias 
                ORDER BY created_at DESC
            '''), con=conn)
            
            # normalize
            if 'created_at' in df.columns:
                df['created_at'] = pd.to_datetime(df['created_at'])
            if 'data_ocorrido' in df.columns:
                df['data_ocorrido'] = pd.to_datetime(df['data_ocorrido'])
                
            print(f"✅ Carregados {len(df)} registros do Postgres")
            print(f"📊 Colunas: {', '.join(df.columns)}")
            if len(df) > 0:
                print(f"📊 Período: {df['created_at'].min()} até {df['created_at'].max()}")
                print(f"📊 Prioridades: {df['prioridade'].value_counts().to_dict()}")
                print(f"📊 UFs: {df['uf'].value_counts().to_dict()}")
            return df
    except ImportError as e:
        print(f"⚠️  Driver PostgreSQL não instalado (psycopg2): {e}")
        print("Para instalar: python -m pip install psycopg2-binary")
        return pd.DataFrame()
    except Exception as e:
        print(f"❌ Erro ao conectar no Postgres: {e}")
        import traceback
        traceback.print_exc()
        return pd.DataFrame()


def compute_metrics(df: pd.DataFrame):
    total_conv = df["conversation_id"].nunique()
    fallbacks = df[df["fallback"] == True].shape[0]
    fallback_rate = 0 if total_conv == 0 else fallbacks / total_conv

    # Slot fill: consider only conversations that completed (not abandoned)
    completed = df[~df["abandoned"]].copy()
    if completed.shape[0] == 0:
        slot_fill_rate = 0.0
    else:
        total_slots = completed["slots_total"].sum()
        filled_slots = completed["slots_filled"].sum()
        slot_fill_rate = filled_slots / total_slots if total_slots > 0 else 0.0

    # Time to completion (in minutes) for completed
    completed_times = completed.dropna(subset=["completed_at"]).copy()
    if completed_times.shape[0] > 0:
        completed_times["duration_min"] = (completed_times["completed_at"] - completed_times["created_at"]).dt.total_seconds() / 60.0
        avg_completion = completed_times["duration_min"].mean()
    else:
        avg_completion = np.nan

    escalation_rate = 0 if total_conv == 0 else df[df["escalated"] == True].shape[0] / total_conv
    abandonment_rate = 0 if total_conv == 0 else df[df["abandoned"] == True].shape[0] / total_conv

    # Business metrics
    reports_by_channel = df.groupby("channel").size().rename("count").reset_index()
    reports_by_uf = df.groupby("uf").size().rename("count").reset_index()
    pct_high_priority = 0 if total_conv == 0 else df[df["priority"] == "Alta"].shape[0] / total_conv

    # Time until notification (minutes) for rows with notification_sent_at
    notif = df.dropna(subset=["notification_sent_at"]).copy()
    if notif.shape[0] > 0:
        notif["notif_delay_min"] = (notif["notification_sent_at"] - notif["created_at"]).dt.total_seconds() / 60.0
        avg_notif_delay = notif["notif_delay_min"].mean()
    else:
        avg_notif_delay = np.nan

    return {
        "total_conv": total_conv,
        "fallback_rate": fallback_rate,
        "slot_fill_rate": slot_fill_rate,
        "avg_completion_min": avg_completion,
        "escalation_rate": escalation_rate,
        "abandonment_rate": abandonment_rate,
        "reports_by_channel": reports_by_channel,
        "reports_by_uf": reports_by_uf,
        "pct_high_priority": pct_high_priority,
        "avg_notif_delay_min": avg_notif_delay,
    }


def clean_dataframe(df):
    """Limpa e valida o DataFrame para evitar erros nos gráficos"""
    df = df.copy()
    
    # Clean string columns
    string_cols = ['channel', 'uf', 'priority', 'conversation_id']
    for col in string_cols:
        if col in df.columns:
            df[col] = df[col].astype(str).replace(['nan', 'None', ''], pd.NA)
            df[col] = df[col].fillna('N/I' if col in ['uf', 'priority'] else 'unknown')
    
    # Ensure datetime columns
    datetime_cols = ['created_at', 'completed_at', 'notification_sent_at']
    for col in datetime_cols:
        if col in df.columns:
            df[col] = pd.to_datetime(df[col], errors='coerce')
    
    # Ensure boolean columns
    bool_cols = ['fallback', 'escalated', 'abandoned']
    for col in bool_cols:
        if col in df.columns:
            df[col] = df[col].fillna(False).astype(bool)
    
    # Ensure numeric columns
    numeric_cols = ['slots_filled', 'slots_total']
    for col in numeric_cols:
        if col in df.columns:
            df[col] = pd.to_numeric(df[col], errors='coerce').fillna(0)
    
    return df

def main():
    st.set_page_config(page_title="Monitoramento - Chatbot de Denúncias", layout="wide")
    st.title("Monitoramento & Qualidade — Chatbot de Denúncias")

    # Carregar dados
    df = load_or_generate_data(800)
    df = clean_dataframe(df)
    
    # Criar abas
    tab1, tab2 = st.tabs(["📊 Dashboard Principal", "🔍 Análise de Logs MongoDB"])
    
    with tab1:
        show_main_dashboard(df)
    
    with tab2:
        show_mongodb_analysis(df)

def show_mongodb_analysis(df):
    """Aba específica para análise dos logs do MongoDB"""
    st.header("🔍 Análise Detalhada dos Logs MongoDB")
    
    # Verificar se temos logs do MongoDB
    if hasattr(df, 'attrs') and 'mongo_logs' in df.attrs:
        mongo_logs = df.attrs['mongo_logs']
        
        if not mongo_logs.empty:
            st.success(f"📊 Analisando {len(mongo_logs)} logs do MongoDB")
            
            # Informações básicas dos logs
            col1, col2, col3 = st.columns(3)
            
            with col1:
                st.metric("Total de Logs", len(mongo_logs))
                st.metric("Período de Logs", 
                         f"{mongo_logs['timestamp'].min().date()} a {mongo_logs['timestamp'].max().date()}")
            
            with col2:
                # Componentes mais ativos
                components = mongo_logs['component'].value_counts()
                st.write("**Componentes Ativos:**")
                for comp, count in components.head().items():
                    st.write(f"• {comp}: {count} logs")
            
            with col3:
                # Níveis de log
                levels = mongo_logs['level'].value_counts()
                st.write("**Níveis de Log:**")
                for level, count in levels.items():
                    st.write(f"• {level}: {count}")
                
                # Métricas de escalonamento
                escalation_logs = mongo_logs[
                    (mongo_logs.get('intentName', '') == 'falar-com-atendente') |
                    mongo_logs.get('message', '').astype(str).str.contains('Solicitação de escalonamento', na=False)
                ]
                escalation_sessions = escalation_logs['dialogflowSessionId'].nunique() if not escalation_logs.empty else 0
                st.write("**Escalonamentos:**")
                st.write(f"• Sessões: {escalation_sessions}")
                st.write(f"• Total logs: {len(escalation_logs)}")
            
            # Gráficos de análise
            st.subheader("📈 Visualizações dos Logs")
            
            viz1, viz2 = st.columns(2)
            
            with viz1:
                st.write("**Atividade por Componente**")
                components_df = mongo_logs['component'].value_counts().reset_index()
                components_df.columns = ['Componente', 'Logs']
                st.bar_chart(components_df.set_index('Componente'))
            
            with viz2:
                st.write("**Logs por Nível**")
                levels_df = mongo_logs['level'].value_counts().reset_index()
                levels_df.columns = ['Nível', 'Quantidade']
                st.bar_chart(levels_df.set_index('Nível'))
            
            # Timeline de atividade
            st.subheader("⏰ Timeline de Atividade")
            mongo_logs_timeline = mongo_logs.copy()
            mongo_logs_timeline['hour'] = mongo_logs_timeline['timestamp'].dt.hour
            hourly_activity = mongo_logs_timeline.groupby('hour').size().reset_index(name='logs')
            
            timeline_chart = alt.Chart(hourly_activity).mark_line(point=True).encode(
                x=alt.X('hour:O', title='Hora do Dia'),
                y=alt.Y('logs:Q', title='Número de Logs'),
                tooltip=['hour:O', 'logs:Q']
            ).properties(height=300, title="Atividade de Logs por Hora")
            
            st.altair_chart(timeline_chart, use_container_width=True)
            
            # Análise de fallbacks
            st.subheader("💬 Análise de Fallbacks")
            fallback_logs = mongo_logs[
                (mongo_logs.get('intentName', '') == 'Default Fallback Intent') |
                mongo_logs.get('message', '').astype(str).str.contains('Fallback detectado', na=False)
            ]
            
            if not fallback_logs.empty:
                st.success(f"Encontrados {len(fallback_logs)} logs de fallback")
                
                # Frases que causaram fallback
                fallback_phrases = []
                for _, log in fallback_logs.iterrows():
                    query_text = log.get('queryText')
                    if query_text and pd.notna(query_text):
                        fallback_phrases.append(query_text)
                
                if fallback_phrases:
                    st.write("**Frases que causaram fallback:**")
                    unique_phrases = list(set(fallback_phrases))[:10]
                    for i, phrase in enumerate(unique_phrases, 1):
                        st.write(f"{i}. {phrase}")
            else:
                st.info("Nenhum log de fallback encontrado")
            
            # Análise de escalonamentos
            st.subheader("📞 Análise de Escalonamentos")
            escalation_logs = mongo_logs[
                (mongo_logs.get('intentName', '') == 'falar-com-atendente') |
                mongo_logs.get('message', '').astype(str).str.contains('Solicitação de escalonamento', na=False) |
                mongo_logs.get('message', '').astype(str).str.contains('falar com atendente', case=False, na=False)
            ]
            
            if not escalation_logs.empty:
                st.warning(f"Encontradas {len(escalation_logs)} solicitações de escalonamento")
                
                # Escalonamentos por sessão única
                unique_sessions = escalation_logs['dialogflowSessionId'].nunique()
                st.metric("Sessões que solicitaram escalonamento", unique_sessions)
                
                # Timeline de escalonamentos
                escalation_timeline = escalation_logs.copy()
                escalation_timeline['hour'] = escalation_timeline['timestamp'].dt.hour
                hourly_escalations = escalation_timeline.groupby('hour').size().reset_index(name='escalations')
                
                if len(hourly_escalations) > 0:
                    escalation_chart = alt.Chart(hourly_escalations).mark_bar().encode(
                        x=alt.X('hour:O', title='Hora do Dia'),
                        y=alt.Y('escalations:Q', title='Escalonamentos'),
                        color=alt.value('#ff6b6b'),
                        tooltip=['hour:O', 'escalations:Q']
                    ).properties(height=250, title="Escalonamentos por Hora")
                    
                    st.altair_chart(escalation_chart, use_container_width=True)
                
                # Frases que levaram ao escalonamento
                escalation_phrases = []
                for _, log in escalation_logs.iterrows():
                    query_text = log.get('queryText')
                    if query_text and pd.notna(query_text):
                        escalation_phrases.append(query_text)
                
                if escalation_phrases:
                    st.write("**Frases que levaram ao escalonamento:**")
                    unique_phrases = list(set(escalation_phrases))[:10]
                    for i, phrase in enumerate(unique_phrases, 1):
                        st.write(f"{i}. {phrase}")
                
                # Últimos escalonamentos
                st.write("**Últimos Escalonamentos:**")
                recent_escalations = escalation_logs.sort_values('timestamp', ascending=False).head(5)
                for _, escalation in recent_escalations.iterrows():
                    session_short = escalation.get('dialogflowSessionId', 'N/A')[:8] + '...' if escalation.get('dialogflowSessionId') else 'N/A'
                    query = escalation.get('queryText', 'N/A')
                    st.write(f"📞 [{escalation['timestamp'].strftime('%H:%M:%S')}] Sessão {session_short}: '{query}'")
                    
            else:
                st.success("✅ Nenhuma solicitação de escalonamento encontrada!")
            
            # Análise de erros
            st.subheader("🚨 Análise de Erros")
            error_logs = mongo_logs[mongo_logs['level'] == 'ERROR']
            
            if not error_logs.empty:
                st.warning(f"Encontrados {len(error_logs)} logs de erro")
                
                error_components = error_logs['component'].value_counts()
                st.write("**Erros por Componente:**")
                for comp, count in error_components.items():
                    st.write(f"• {comp}: {count} erros")
                
                # Mostrar últimos erros
                st.write("**Últimos Erros:**")
                recent_errors = error_logs.sort_values('timestamp', ascending=False).head(5)
                for _, error in recent_errors.iterrows():
                    st.write(f"⚠️ [{error['timestamp'].strftime('%H:%M:%S')}] {error['component']}: {error['message'][:100]}...")
            else:
                st.success("✅ Nenhum erro encontrado nos logs!")
            
            # Raw data
            with st.expander("🔍 Visualizar Logs Brutos"):
                safe_logs = sanitize_for_streamlit(mongo_logs, max_rows=50)
                try:
                    st.dataframe(safe_logs)
                except Exception as e:
                    st.error(f"Erro ao exibir logs brutos: {str(e)}")
                    st.text("Dados (formato texto):")
                    st.text(str(safe_logs.head(10)))
        
        else:
            st.warning("Nenhum log do MongoDB encontrado")
    else:
        st.error("Dados do MongoDB não disponíveis. Verifique a conexão.")

def show_main_dashboard(df):
    """Mostra o dashboard principal com dados do Postgres"""
    
    # Debug info
    st.sidebar.markdown("### Debug Info")
    st.sidebar.write(f"Total registros carregados: {len(df)}")
    st.sidebar.write(f"Colunas disponíveis: {', '.join(df.columns)}")
    
    if len(df) > 0:
        # Determinar tipo de dados mais precisamente
        data_type = "Sintéticos"
        if 'protocolo' in df.columns:
            data_type = "Postgres (Denúncias)"
            if 'fallback' in df.columns and df['fallback'].any():
                data_type = "Postgres + MongoDB (Combinado)"
        elif any(col.startswith('conversation_id') for col in df.columns):
            data_type = "MongoDB (Logs)"
            
        st.sidebar.write(f"Fonte de dados: {data_type}")
        st.sidebar.write(f"Período: {df['created_at'].min().date()} a {df['created_at'].max().date()}")
        
        # Show data quality info
        st.sidebar.markdown("#### Qualidade dos Dados")
        st.sidebar.write(f"Canais únicos: {df['channel'].nunique()}")
        st.sidebar.write(f"UFs únicas: {df['uf'].nunique()}")
        st.sidebar.write(f"Prioridades únicas: {df['priority'].nunique()}")
        
        # Show data source details
        if 'protocolo' in df.columns:
            valid_protocols = df[df['protocolo'].notna() & (df['protocolo'] != '')]
            st.sidebar.write(f"Protocolos válidos: {len(valid_protocols)}")
        
        if 'fallback' in df.columns:
            fallback_count = df['fallback'].sum()
            st.sidebar.write(f"Conversas com fallback: {fallback_count}")
        
        # Show sample data
        with st.sidebar.expander("Amostra dos dados"):
            sample_cols = ['channel', 'uf', 'priority', 'created_at']
            if 'protocolo' in df.columns:
                sample_cols.insert(0, 'protocolo')
            sample_df = df[sample_cols].head().copy()

            # Diagnostic: log problematic columns/types for this sample (helps Cloud debugging)
            diagnose_problem_columns(sample_df, sample_rows=10)

            # Use the generic sanitizer to produce a DataFrame safe for Streamlit/pyarrow
            safe_sample = sanitize_for_streamlit(sample_df, max_rows=10)
            
            # Additional safety check for Streamlit Cloud serialization issues
            try:
                st.write(safe_sample)
            except Exception as e:
                st.error(f"Erro ao exibir amostra dos dados: {str(e)}")
                # Fallback: show data as plain text
                st.text("Dados (formato texto):")
                for col in safe_sample.columns:
                    st.text(f"{col}: {list(safe_sample[col].values)}")

    # Normalize column names that may come from different sources (Portuguese vs English)
    # Ensure we have the expected keys used across the app
    if 'priority' not in df.columns:
        if 'prioridade' in df.columns:
            df['priority'] = df['prioridade']
        else:
            df['priority'] = 'N/I'
    if 'created_at' not in df.columns and 'timestamp' in df.columns:
        df['created_at'] = pd.to_datetime(df['timestamp'], errors='coerce')
    if 'notification_sent_at' not in df.columns:
        if 'notification_sent' in df.columns:
            df['notification_sent_at'] = pd.to_datetime(df['notification_sent'], errors='coerce')
        elif 'notification_sent_at' in df.columns:
            df['notification_sent_at'] = pd.to_datetime(df['notification_sent_at'], errors='coerce')
        else:
            df['notification_sent_at'] = pd.NaT
    if 'uf' not in df.columns and 'UF' in df.columns:
        df['uf'] = df['UF']
    if 'channel' not in df.columns and 'canal' in df.columns:
        df['channel'] = df['canal']
    
    # Fill missing columns with defaults when loading from Postgres only
    required_columns = {
        'conversation_id': lambda x: df.get('protocolo', f'conv_{x}'),
        'channel': 'web',
        'uf': 'n/i', 
        'priority': 'N/I',
        'completed_at': pd.NaT,
        'notification_sent_at': pd.NaT,
        'fallback': False,
        'fallback_phrase': None,
        'slots_filled': 6,
        'slots_total': 6,
        'escalated': False,
        'abandoned': False,
        'intent_final': 'create_report',
        'protocol': lambda x: df.get('protocolo', f'SUP-{x}')
    }
    
    for col, default_val in required_columns.items():
        if col not in df.columns:
            if callable(default_val):
                df[col] = [default_val(i) for i in range(len(df))]
            else:
                df[col] = default_val

    # ensure datetime dtypes
    for c in ["created_at", "completed_at", "notification_sent_at"]:
        if c in df.columns:
            df[c] = pd.to_datetime(df[c], errors="coerce")

    # Sidebar filters
    st.sidebar.header("Filtros")
    min_date = df["created_at"].min().date()
    max_date = df["created_at"].max().date()
    date_range = st.sidebar.date_input("Período", [min_date, max_date])
    
    # Handle date range safely
    if isinstance(date_range, tuple) and len(date_range) == 2:
        start_date, end_date = date_range
    elif isinstance(date_range, list) and len(date_range) == 2:
        start_date, end_date = date_range[0], date_range[1]
    elif hasattr(date_range, '__len__') and len(date_range) == 1:
        start_date = end_date = date_range[0]
    else:
        start_date, end_date = min_date, max_date
    
    # Handle filters safely - clean data first
    channel_options = [c for c in sorted(df["channel"].unique()) if pd.notna(c) and c != '' and c != 'unknown']
    if not channel_options:
        channel_options = ['web']  # fallback
    
    uf_options = [u for u in sorted(df["uf"].unique()) if pd.notna(u) and u != '' and u != 'n/i']
    if not uf_options:
        uf_options = ['sp']  # fallback
    
    priority_options = [p for p in sorted(df["priority"].unique()) if pd.notna(p) and p != '' and p != 'N/I']
    if not priority_options:
        priority_options = ['Média']  # fallback
    
    # Initialize session state for filters if not exists
    if 'channels_selected' not in st.session_state:
        st.session_state.channels_selected = channel_options
    if 'ufs_selected' not in st.session_state:
        st.session_state.ufs_selected = uf_options
    if 'priorities_selected' not in st.session_state:
        st.session_state.priorities_selected = priority_options
    
    channels = st.sidebar.multiselect("Canal", options=channel_options, default=st.session_state.channels_selected)
    ufs = st.sidebar.multiselect("UF", options=uf_options, default=st.session_state.ufs_selected)
    priorities = st.sidebar.multiselect("Prioridade", options=priority_options, default=st.session_state.priorities_selected)
    
    # Reset filters button
    if st.sidebar.button("Resetar Filtros"):
        st.session_state.channels_selected = channel_options
        st.session_state.ufs_selected = uf_options
        st.session_state.priorities_selected = priority_options
        st.rerun()

    # apply filters safely - ensure we have selections
    if not channels:
        channels = channel_options
    if not ufs:
        ufs = uf_options  
    if not priorities:
        priorities = priority_options
    
    # Create mask with safe date filtering
    mask = (df["created_at"].dt.date >= start_date) & (df["created_at"].dt.date <= end_date)
    
    # Safe filtering - handle missing/null values
    mask &= df["channel"].fillna('unknown').isin(channels + ['unknown'])
    mask &= df["uf"].fillna('n/i').isin(ufs + ['n/i'])
    mask &= df["priority"].fillna('N/I').isin(priorities + ['N/I'])

    filtered = df[mask].copy()
    
    # Ensure we have some data
    if len(filtered) == 0:
        st.warning("⚠️ Nenhum registro encontrado com os filtros selecionados. Mostrando todos os dados.")
        filtered = df.copy()

    metrics = compute_metrics(filtered)

    # Dados já combinados incluem informações do Postgres, não precisamos recarregar
    print(f"✅ Usando dados já combinados (Postgres + MongoDB) para métricas")

    # Top metrics in columns - only relevant for Postgres data
    c1, c2 = st.columns(2)
    c1.metric("Conversas", metrics["total_conv"])
    c2.metric("Slot fill", f"{metrics['slot_fill_rate']*100:.1f}%")



    # Business metrics
    b1, b2 = st.columns(2)
    b1.subheader("Denúncias por Canal")
    if not metrics["reports_by_channel"].empty and len(metrics["reports_by_channel"]) > 0:
        # Clean data for Altair - remove empty/null values
        channel_data = metrics["reports_by_channel"].copy()
        channel_data = channel_data[channel_data['channel'].notna() & (channel_data['channel'] != '')]
        
        if len(channel_data) > 0:
            chart1 = alt.Chart(channel_data).mark_bar().encode(
                x=alt.X('channel:N', sort='-y', title='Canal'),
                y=alt.Y('count:Q', title='Quantidade'),
                color=alt.Color('channel:N', legend=None),
                tooltip=['channel:N', 'count:Q']
            ).properties(height=300)
            b1.altair_chart(chart1, use_container_width=True)
        else:
            b1.bar_chart(pd.Series([1], index=['Sem dados']))
    else:
        b1.info("Sem dados de canal no período selecionado")

    b2.subheader("Denúncias por UF")
    if not metrics["reports_by_uf"].empty and len(metrics["reports_by_uf"]) > 0:
        # Clean data for Altair - remove empty/null values
        uf_data = metrics["reports_by_uf"].copy()
        uf_data = uf_data[uf_data['uf'].notna() & (uf_data['uf'] != '') & (uf_data['uf'] != 'n/i')]
        
        if len(uf_data) > 0:
            chart2 = alt.Chart(uf_data).mark_bar().encode(
                x=alt.X('uf:N', sort='-y', title='UF'),
                y=alt.Y('count:Q', title='Quantidade'),
                color=alt.Color('uf:N', legend=None),
                tooltip=['uf:N', 'count:Q']
            ).properties(height=300)
            b2.altair_chart(chart2, use_container_width=True)
        else:
            b2.bar_chart(pd.Series([1], index=['Sem dados']))
    else:
        b2.info("Sem dados de UF no período selecionado")

    st.subheader("Prioridades das Denúncias")
    p1, p2 = st.columns([1, 1])
    
    # Safe priority chart
    priority_series = filtered["priority"].fillna('N/I').value_counts()
    if len(priority_series) > 0:
        p1.bar_chart(priority_series)
    else:
        p1.info("Sem dados de prioridade")
    
    p2.metric("% Alta prioridade", f"{metrics['pct_high_priority']*100:.1f}%", delta=None)

    # Seção de Performance removida - dados sintéticos não relevantes para Postgres
    # Para dados reais, implementar métricas baseadas em campos reais da tabela denuncias

    # Time series of counts
    st.subheader("Série temporal — Conversas por dia")
    if len(filtered) > 0:
        timeseries = filtered.copy()
        # Use data_ocorrido if available, otherwise fallback to created_at
        if 'data_ocorrido' in timeseries.columns and timeseries['data_ocorrido'].notna().any():
            timeseries["day"] = timeseries["data_ocorrido"].dt.date
        else:
            timeseries["day"] = timeseries["created_at"].dt.date
        ts = timeseries.groupby("day").size().reset_index(name='count')
        if len(ts) > 0:
            st.line_chart(ts.set_index('day'))
        else:
            st.info("Sem dados para série temporal")
    else:
        st.info("Sem dados para série temporal")

    # Fallback phrases and curation
    st.subheader("Frases de Fallback — Ciclo de melhoria")
    fallback_data = filtered[filtered["fallback"] == True]
    if len(fallback_data) > 0 and 'fallback_phrase' in fallback_data.columns:
        fallback_phrases = fallback_data["fallback_phrase"].dropna().value_counts().reset_index()
        if len(fallback_phrases) > 0:
            fallback_phrases.columns = ["phrase", "count"]
            st.dataframe(fallback_phrases)
        else:
            st.info("Nenhuma frase de fallback registrada no período")
    else:
        st.info("Nenhuma frase de fallback registrada no período")

    # simple selection and curation area
    fallback_data = filtered[filtered["fallback"] == True]
    if len(fallback_data) > 0 and 'fallback_phrase' in fallback_data.columns:
        fallback_phrases = fallback_data["fallback_phrase"].dropna().value_counts().reset_index()
        if len(fallback_phrases) > 0:
            fallback_phrases.columns = ["phrase", "count"]
            st.write("Selecione frases para marcar como 'para curadoria' (isso gera CSV para export).")
            selected = st.multiselect("Frases", options=fallback_phrases["phrase"].tolist())
            if st.button("Marcar para curadoria") and selected:
                cur_df = pd.DataFrame({"phrase": selected, "marked_at": datetime.now()})
                buf = io.StringIO()
                cur_df.to_csv(buf, index=False)
                st.download_button("Download CSV de curadoria", data=buf.getvalue(), file_name="curadoria_fallback.csv", mime="text/csv")

    # Export filtered data
    st.subheader("Exportar dados filtrados")
    csv = filtered.to_csv(index=False)
    st.download_button("Exportar CSV", data=csv, file_name="filtered_reports.csv", mime="text/csv")

    # Export a PNG of the channel chart
    st.subheader("Exportar gráfico PNG")
    ch = metrics["reports_by_channel"]
    if not ch.empty and len(ch) > 0:
        fig, ax = plt.subplots(figsize=(6, 3))
        ch_clean = ch[ch['channel'].notna() & (ch['channel'] != '')]
        if len(ch_clean) > 0:
            ax.bar(ch_clean['channel'], ch_clean['count'], color='tab:blue')
            ax.set_title('Denúncias por Canal')
            ax.set_ylabel('count')
            plt.xticks(rotation=45)
            buf_png = io.BytesIO()
            fig.tight_layout()
            fig.savefig(buf_png, format='png')
            buf_png.seek(0)
            st.download_button("Download PNG (Canal)", data=buf_png, file_name="reports_by_channel.png", mime="image/png")
        else:
            st.info("Sem dados válidos para gerar gráfico")
    else:
        st.info("Sem dados para gerar gráfico")



    # Cycle of improvement guidance
    st.markdown("### Ciclo de melhoria (recomendações)")
    st.markdown("- Coletar frases de fallback (~ logs de conversação com label `fallback`) em um bucket separado para revisão humana.")
    st.markdown("- Curadoria: agrupar por similaridade (tokenização), remover ruído, criar exemplos positivos/negativos.")
    st.markdown("- Atualizar intents e sinônimos no Dialogflow: adicionar exemplos coletados e ajustar entidades.")
    st.markdown("- Agendar rotinas diárias/semanais para re-treino/curadoria e medir redução da fallback rate após alterações.")


if __name__ == '__main__':
    main()
