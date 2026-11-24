namespace Demo.Models;

/// <summary>A registered user.</summary>
public record User(string Name)
{
    public string Display() => Name.ToUpperInvariant();
}
