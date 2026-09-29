def format_report(inventory):
    lines = []
    width = max(len(n) for n in inventory.items)
    for name, item in sorted(inventory.items.items()):
        lines.append(f"{name.ljust(width)}  {item.qty:>5}  {item.price:>8.2f}")
    lines.append(f"TOTAL {inventory.total_value()}")
    return "\n".join(lines)


def export_csv(inventory, path):
    with open(path, "w") as f:
        for item in inventory.items.values():
            f.write(f"{item.name};{item.qty};{item.price}\n")
