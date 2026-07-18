FROM mcr.microsoft.com/dotnet/sdk:8.0 AS build
WORKDIR /src
COPY backend/Reforma.Api/Reforma.Api.csproj backend/Reforma.Api/
RUN dotnet restore backend/Reforma.Api/Reforma.Api.csproj
COPY backend/Reforma.Api backend/Reforma.Api
RUN dotnet publish backend/Reforma.Api/Reforma.Api.csproj -c Release -o /app/publish /p:UseAppHost=false

FROM mcr.microsoft.com/dotnet/aspnet:8.0
WORKDIR /app
ENV ASPNETCORE_URLS=http://+:8080
COPY --from=build /app/publish .
EXPOSE 8080
ENTRYPOINT ["dotnet", "Reforma.Api.dll"]
