# criticality: low
"""Small shared helpers."""


def money(amount):
    return f"{amount:.2f}"


def slugify(text):
    return "-".join(text.lower().split())


def render(template, **values):
    return template.format(**values)
